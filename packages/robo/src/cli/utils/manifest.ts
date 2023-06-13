import fs from 'node:fs/promises'
import path from 'node:path'
import {
	ApiEntry,
	BaseConfig,
	CommandConfig,
	CommandEntry,
	CommandOption,
	Config,
	EventConfig,
	Manifest,
	MiddlewareEntry,
	Plugin,
	Scope
} from '../../types/index.js'
import { logger } from '../../core/logger.js'
import { findPackagePath, hasProperties, packageJson } from './utils.js'
import { loadConfig } from '../../core/config.js'
import { pathToFileURL } from 'node:url'
import { DefaultGen } from './generate-defaults.js'
import { color } from './color.js'
import type { PermissionsString } from 'discord.js'

// Global manifest reference
let _manifest: Manifest = null

/**
 * Returns the currently loaded manifest.
 * May return null if manifest has yet to load. Use `loadManifest` to load it first.
 */
export function getManifest(): Manifest | null {
	return _manifest
}

const BASE_MANIFEST: Manifest = {
	__README: 'This file was automatically generated by Robo.js - do not edit manually.',
	__robo: {
		config: null,
		type: 'robo'
	},
	api: {},
	commands: {},
	context: {
		message: {},
		user: {}
	},
	events: {},
	permissions: [],
	middleware: [],
	scopes: []
}

// TODO: Replace with file scanning to detect actual usage
// Bot permissions are not directly tied to intents
const INTENT_PERMISSIONS: Record<string, PermissionsString[]> = {
	DirectMessages: [],
	DirectMessageReactions: [],
	DirectMessageTyping: [],
	Guilds: ['ViewChannel'],
	GuildMembers: [],
	GuildBans: ['BanMembers', 'ViewAuditLog'],
	GuildEmojisAndStickers: ['ManageEmojisAndStickers'],
	GuildIntegrations: ['ManageGuild', 'ViewAuditLog'],
	GuildWebhooks: ['ManageWebhooks', 'ViewAuditLog'],
	GuildInvites: ['CreateInstantInvite', 'ManageGuild'],
	GuildVoiceStates: ['Connect', 'Speak', 'MuteMembers', 'DeafenMembers', 'MoveMembers', 'UseVAD'],
	GuildPresences: [],
	GuildMessages: ['ReadMessageHistory', 'SendMessages'],
	GuildMessageReactions: ['ReadMessageHistory', 'AddReactions'],
	GuildMessageTyping: ['ReadMessageHistory']
}

const mergeEvents = (baseEvents: Record<string, EventConfig[]>, newEvents: Record<string, EventConfig[]>) => {
	const mergedEvents = { ...baseEvents }

	for (const eventName in newEvents) {
		const baseEventArray = mergedEvents[eventName] || []
		const newEventArray = newEvents[eventName]

		mergedEvents[eventName] = [...baseEventArray, ...newEventArray]
	}

	return mergedEvents
}

export async function generateManifest(generatedDefaults: DefaultGen, type: 'plugin' | 'robo'): Promise<Manifest> {
	const config = await loadConfig()
	const pluginsManifest = type === 'plugin' ? BASE_MANIFEST : await readPluginManifest(config?.plugins)
	const api = await generateEntries<ApiEntry>('api', [])
	const commands = await generateEntries<CommandEntry>('commands', Object.keys(generatedDefaults?.commands ?? {}))
	const context = await generateEntries<CommandEntry>('context', Object.keys(generatedDefaults?.context ?? {}))
	const events = await generateEntries<EventConfig>('events', Object.keys(generatedDefaults?.events ?? {}))
	const middleware = Object.values(await generateEntries<MiddlewareEntry>('middleware', [])).flat()

	const newManifest: Manifest = {
		...BASE_MANIFEST,
		...pluginsManifest,
		__robo: {
			config: redactPluginOptions(config),
			type: type,
			updatedAt: new Date().toISOString(),
			version: packageJson.version
		},
		api: {
			...pluginsManifest.api,
			...api
		},
		commands: {
			...pluginsManifest.commands,
			...commands
		} as Record<string, CommandConfig>,
		context: {
			message: {
				...pluginsManifest.context?.message,
				...context.message
			},
			user: {
				...pluginsManifest.context?.user,
				...context.user
			}
		},
		events: mergeEvents(pluginsManifest.events, events),
		middleware: [...pluginsManifest.middleware, ...middleware]
	}

	// Smartly detect permissions and scopes
	newManifest.permissions = await generatePermissions(config)
	newManifest.scopes = generateScopes(config, newManifest)

	// Make sure newManifest commands are in alphabetical order
	newManifest.api = Object.fromEntries(Object.entries(newManifest.api).sort(([a], [b]) => a.localeCompare(b)))
	newManifest.commands = Object.fromEntries(Object.entries(newManifest.commands).sort(([a], [b]) => a.localeCompare(b)))
	newManifest.events = Object.fromEntries(Object.entries(newManifest.events).sort(([a], [b]) => a.localeCompare(b)))

	// Our new source of truth is ready!
	await fs.mkdir('.robo', { recursive: true })
	await fs.writeFile(path.join('.robo', 'manifest.json'), JSON.stringify(newManifest, null, 2))
	logger.debug(`Generated manifest:`, newManifest)
	return newManifest
}

async function readPluginManifest(plugins: Plugin[]): Promise<Manifest> {
	let pluginsManifest = BASE_MANIFEST
	if (!plugins?.length) {
		return pluginsManifest
	}

	logger.debug(`Reading plugins...`, plugins)
	for (const plugin of plugins) {
		const pluginName = typeof plugin === 'string' ? plugin : plugin[0]
		const packagePath = await findPackagePath(pluginName, process.cwd())
		const manifest = await loadManifest(pluginName, packagePath)

		// For now, we only supporting merging plugin permissions as strings
		const validPermissions = manifest.permissions && typeof manifest.permissions !== 'number'

		pluginsManifest = {
			...pluginsManifest,
			api: {
				...pluginsManifest.api,
				...manifest.api
			},
			commands: {
				...pluginsManifest.commands,
				...manifest.commands
			},
			context: {
				message: {
					...pluginsManifest.context?.message,
					...manifest.context?.message
				},
				user: {
					...pluginsManifest.context?.user,
					...manifest.context?.user
				}
			},
			events: {
				...pluginsManifest.events,
				...manifest.events
			},
			middleware: [...(pluginsManifest.middleware ?? []), ...(manifest.middleware ?? [])],
			permissions: [
				...(pluginsManifest.permissions as PermissionsString[]),
				...(validPermissions ? (manifest.permissions as PermissionsString[]) : [])
			],
			scopes: [...pluginsManifest.scopes, ...(manifest.scopes ?? [])]
		}
	}

	return pluginsManifest
}

export async function loadManifest(name = '', basePath = ''): Promise<Manifest> {
	const manifestPath = path.join(basePath || '.', '.robo', 'manifest.json')
	let manifest: Manifest

	try {
		const manifestContent = await fs.readFile(manifestPath, 'utf-8')
		if (!manifestContent?.trim()) {
			manifest = BASE_MANIFEST
			return manifest
		}
		manifest = JSON.parse(manifestContent) as Manifest

		// Inject plugin info if this is being built as a plugin
		if (name && basePath) {
			const pluginInfo: BaseConfig = {
				__auto: true,
				__plugin: {
					name,
					path: basePath
				}
			}

			Object.keys(manifest.api ?? {}).forEach((key) => {
				manifest.api[key].__auto = true
				manifest.api[key].__plugin = {
					name,
					path: basePath
				}
			})
			Object.keys(manifest.commands).forEach((key) => {
				manifest.commands[key].__auto = true
				manifest.commands[key].__plugin = {
					name,
					path: basePath
				}
			})
			Object.keys(manifest.context?.message ?? {}).forEach((key) => {
				manifest.context.message[key].__auto = true
				manifest.context.message[key].__plugin = {
					name,
					path: basePath
				}
			})
			Object.keys(manifest.context?.user ?? {}).forEach((key) => {
				manifest.context.user[key].__auto = true
				manifest.context.user[key].__plugin = {
					name,
					path: basePath
				}
			})
			Object.keys(manifest.events).forEach((key) => {
				manifest.events[key] = manifest.events[key].map((eventConfig) => ({
					...pluginInfo,
					...eventConfig
				}))
			})
			manifest.middleware = manifest.middleware?.map((middleware) => ({
				...pluginInfo,
				...middleware
			}))
		}

		return manifest
	} catch (e) {
		if (hasProperties<{ code: unknown }>(e, ['code']) && e.code === 'ENOENT') {
			manifest = BASE_MANIFEST
			return manifest
		}
		throw e
	} finally {
		_manifest = manifest
	}
}

async function generatePermissions(config: Config): Promise<PermissionsString[]> {
	const permissions: PermissionsString[] = []
	const autoPermissions = config?.invite?.autoPermissions ?? true

	if (autoPermissions) {
		// Scan all intents to come up with a list of permissions we need
		const intents = Object.values(config.clientOptions?.intents || {})
		for (const intent of intents) {
			if (typeof intent === 'string') {
				// Determine what permissions this intent requires
				const intentPermissions = INTENT_PERMISSIONS[intent]
				if (intentPermissions) {
					permissions.push(...intentPermissions)
				}
			}
		}
	}

	// Include all permissions specified in the config
	const configPermissions = config.invite?.permissions
	if (typeof configPermissions !== 'number' && configPermissions?.length) {
		permissions.push(...configPermissions)
	}

	// Sort permissions alphabetically (this is very important to me)
	permissions.sort((a, b) => a.localeCompare(b))

	// Filter out duplicates and nulls before returning
	return [...new Set(permissions)].filter((permission) => permission)
}

function generateScopes(config: Config, newManifest: Manifest): Scope[] {
	const scopes: Scope[] = ['bot']

	// Include application.commands if there are any commands in the manifest
	if (Object.keys(newManifest.commands).length) {
		scopes.push('applications.commands')
	}

	// Include all scopes specified in the config
	if (config.invite?.scopes?.length) {
		scopes.push(...config.invite.scopes)
	}

	// Sort scopes alphabetically (this is very important to me)
	scopes.sort((a, b) => a.localeCompare(b))

	// Filter out duplicates and nulls before returning
	return [...new Set(scopes)].filter((scope) => scope)
}

interface ScanDirOptions {
	recurseModules?: boolean
	recursionKeys?: string[]
	recursionModuleKeys?: string[]
	recursionPath?: string
	type: 'api' | 'commands' | 'context' | 'events' | 'middleware'
}

type ScanDirPredicate = (fileKeys: string[], fullPath: string, moduleKeys: string[]) => Promise<void>

/**
 * Walks through a directory and passes only files to the predicate function.
 * This function is recursive and includes general data about the file.
 *
 * Files will always be walked first, then directories after.
 * This ensures parent entries are always created before children.
 */
async function scanDir(predicate: ScanDirPredicate, options: ScanDirOptions) {
	const { recurseModules = true, recursionKeys = [], recursionModuleKeys = [], recursionPath, type } = options
	const directoryPath = recursionPath ?? path.join(process.cwd(), '.robo', 'build', type)
	const directory = await fs.readdir(directoryPath)

	// Filter out directories using fs.stat in parallel
	const files: string[] = []
	const directories: string[] = []

	await Promise.all(
		directory.map(async (file) => {
			const fullPath = path.resolve(directoryPath, file)
			const stats = await fs.stat(fullPath)

			// Group files and directories accordingly
			if (stats.isFile() && path.extname(file) !== '.js') {
				return
			} else if (stats.isFile()) {
				files.push(file)
			} else if (stats.isDirectory()) {
				directories.push(file)
			} else {
				logger.debug(stats)
				logger.warn(`Unknown file or directory encountered while scanning directory: ${fullPath}`)
			}
		})
	)

	// If not currently recursing, be sure to also check the "modules" directory
	const modules: string[] = []
	if (recurseModules) {
		try {
			// Read the modules directory one level higher than the current directory
			const modulesPath = recursionPath
				? path.join(recursionPath, '..', 'modules')
				: path.join(process.cwd(), '.robo', 'build', 'modules')
			const modulesDirectory = await fs.readdir(modulesPath)

			// For each module, add it to the list of directories to scan
			await Promise.all(
				modulesDirectory.map(async (module) => {
					const fullPath = path.resolve(modulesPath, module, type)

					// Only add modules to the list of modules to scan
					const stats = await fs.stat(fullPath)
					if (stats.isDirectory()) {
						modules.push(path.join(modulesPath, module, type))
					}
				})
			)
		} catch (error) {
			// Only throw error not related to the directory not existing
			if (hasProperties<{ code: string }>(error, ['code']) && !['ENOENT', 'ENOTDIR'].includes(error.code)) {
				throw error
			}
		}
	}

	// Run the directive on all files first in parallel before recursing
	// This ensures parent entries are always created before children
	await Promise.all(
		files.map(async (file) => {
			const fileKeys = [...recursionKeys, path.basename(file, path.extname(file))]
			const fullPath = path.resolve(directoryPath, file)

			return predicate(fileKeys, fullPath, recursionModuleKeys)
		})
	)

	// Recurse through all directories in parallel now that all parent entries have been created
	await Promise.all(
		directories.map(async (childDir) => {
			const nestedPath = path.resolve(directoryPath, childDir)
			const fileKeys = [...recursionKeys, childDir]
			return scanDir(predicate, {
				recursionKeys: fileKeys,
				recurseModules: false,
				recursionModuleKeys,
				recursionPath: nestedPath,
				type
			})
		})
	)

	// Similarly, recurse through all module directories in parallel
	await Promise.all(
		modules.map(async (module) => {
			const nestedPath = path.resolve(module)
			const moduleKeys = [...recursionModuleKeys, path.basename(path.dirname(module))]
			return scanDir(predicate, {
				recursionKeys: [],
				recurseModules: true,
				recursionModuleKeys: moduleKeys,
				recursionPath: nestedPath,
				type
			})
		})
	)
}

async function generateEntries<T>(type: 'api', generatedKeys: string[]): Promise<Record<string, T>>
async function generateEntries<T>(type: 'commands', generatedKeys: string[]): Promise<Record<string, T>>
async function generateEntries<T>(
	type: 'context',
	generatedKeys: string[]
): Promise<Record<'message' | 'user', Record<string, T>>>
async function generateEntries<T>(type: 'events', generatedKeys: string[]): Promise<Record<string, T[]>>
async function generateEntries<T>(type: 'middleware', generatedKeys: string[]): Promise<Record<string, T>>
async function generateEntries<T>(
	type: 'api' | 'commands' | 'context' | 'events' | 'middleware',
	generatedKeys: string[]
): Promise<Record<string, T | T[] | Record<string, T>>> {
	try {
		const entries: Record<string, T | T[]> = {}

		await scanDir(
			async (fileKeys, fullPath, moduleKeys) => {
				logger.debug(`[${type}] Generating`, fileKeys, 'from', fullPath)
				const isGenerated = generatedKeys.includes(fileKeys.join('/'))
				const importPath = pathToFileURL(fullPath).toString()
				const module = await import(importPath)
				let entry = {
					...getValue(type, module.config),
					__auto: isGenerated ? true : undefined,
					__module: moduleKeys.join('/') || undefined,
					__path: fullPath.replace(process.cwd(), '')
				} as T
				let existingEntry = entries[fileKeys[0]]

				// Sort entry object alphabetically because I'd be a savage if we didn't
				entry = Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) as T

				// Events entries are an array of objects unlike commands which are single objects
				if (type === 'events' && !existingEntry) {
					entries[fileKeys[0]] = existingEntry = []
				}

				if (type === 'events' && Array.isArray(existingEntry)) {
					existingEntry.push(entry)
				}

				// Context entries must be grouped by context type, meaning level 2 nesting
				if (type === 'context' && fileKeys.length === 2) {
					const contextType = fileKeys[0] as 'message' | 'user'
					if (!entries[contextType]) {
						entries[contextType] = {} as T
					}

					// Add the entry to the context type
					(entries[contextType] as Record<string, T>)[fileKeys[1]] = entry
				}

				// Third level command? Add it to the parent subcommand (subcommand group)
				if (type === 'commands' && fileKeys.length === 3) {
					let parentCommand = entries[fileKeys[0]] as CommandEntry

					// Make sure there's no file for the parent command
					// Discord does not allow calling a subcommand's parent directly
					if (parentCommand?.__path) {
						const commandPath = color.bold(`/src/${type}/${parentCommand.__path}`)
						logger.error('You cannot have a parent command alongside subcommand groups! Source: ' + commandPath)
						process.exit(1)
					}

					if (!parentCommand) {
						parentCommand = { subcommands: {} }
						entries[fileKeys[0]] = parentCommand as T
					}

					let parentSubcommand = parentCommand.subcommands[fileKeys[1]] as CommandEntry
					if (parentSubcommand?.__path) {
						const subcommandPath = color.bold(`/src/${type}/${parentSubcommand.__path}`)
						logger.error('You cannot have a subcommand alongside subcommand groups! Source: ' + subcommandPath)
						process.exit(1)
					}

					if (!parentSubcommand) {
						parentSubcommand = { subcommands: {} }
						parentCommand.subcommands[fileKeys[1]] = parentSubcommand as T
					}

					parentSubcommand.subcommands[fileKeys[2]] = entry
				}

				// If this is a second level command, find the parent command and add it as a subcommand
				if (type === 'commands' && fileKeys.length === 2) {
					let parentCommand = entries[fileKeys[0]] as CommandEntry

					// Make sure there's no file for the parent command
					// Discord does not allow calling a subcommand's parent directly
					if (parentCommand?.__path) {
						const commandPath = color.bold(`/src/${type}/${parentCommand.__path}`)
						logger.error('You cannot have a parent command alongside subcommands! Source: ' + commandPath)
						process.exit(1)
					}

					// Append this subcommand to the parent command
					if (!parentCommand) {
						parentCommand = { subcommands: {} }
						entries[fileKeys[0]] = parentCommand as T
					}
					parentCommand.subcommands[fileKeys[1]] = entry
				}

				// Top-level commands are simpler single objects uwu
				if (type === 'commands' && fileKeys.length === 1) {
					entries[fileKeys[0]] = entry
				}

				// Middleware is a single object that gets flattened into an array later
				if (type === 'middleware') {
					entries[fileKeys.join('/')] = entry
				}

				// API Routes are infinitely nested objects
				if (type === 'api') {
					if (fileKeys.length > 1) {
						// Find the parent object based on ApiEntry subroutes
						let parent = entries[fileKeys[0]] as ApiEntry
						if (!parent) {
							parent = { subroutes: {} }
							entries[fileKeys[0]] = parent as T
						}
						if (!parent.subroutes) {
							parent.subroutes = {}
						}

						for (let i = 1; i < fileKeys.length - 1; i++) {
							const key = fileKeys[i]
							if (!parent.subroutes[key]) {
								parent.subroutes[key] = { subroutes: {} }
							}
							parent = parent.subroutes[key]
						}

						// Add the entry to the parent object
						parent.subroutes[fileKeys[fileKeys.length - 1]] = entry
					} else {
						entries[fileKeys[0]] = entry
					}
				}
			},
			{
				type: type
			}
		)

		logger.debug(`Generated ${Object.keys(entries).length} unique ${type}`)
		return entries
	} catch (error) {
		if (hasProperties<{ code: unknown }>(error, ['code']) && error.code === 'ENOENT') {
			// Empty directories are perfectly valid <3
			return {}
		}
		throw error
	}
}

type AllConfig = CommandConfig & EventConfig
function getValue<T extends AllConfig>(
	type: 'api' | 'commands' | 'context' | 'events' | 'middleware',
	config: BaseConfig
): T {
	const value = {} as T
	if (!config) {
		return value
	}

	if (type === 'commands' && config) {
		if ((config as CommandConfig).description) {
			value.description = (config as CommandConfig).description
		}
		if ((config as CommandConfig).descriptionLocalizations) {
			value.descriptionLocalizations = (config as CommandConfig).descriptionLocalizations
		}
		if ((config as CommandConfig).options) {
			value.options = (config as CommandConfig).options.map((option) => {
				const optionValue: CommandOption = {
					name: option.name
				}
				if (option.autocomplete) {
					optionValue.autocomplete = option.autocomplete
				}
				if (option.description) {
					optionValue.description = option.description
				}
				if (option.descriptionLocalizations) {
					optionValue.descriptionLocalizations = option.descriptionLocalizations
				}
				if (option.nameLocalizations) {
					optionValue.nameLocalizations = option.nameLocalizations
				}
				if (option.required) {
					optionValue.required = option.required
				}
				if (option.type) {
					optionValue.type = option.type
				}
				return optionValue
			})

			// Sort options order by required
			value.options.sort((a, b) => {
				if (a.required && !b.required) {
					return -1
				}
				if (!a.required && b.required) {
					return 1
				}
				return 0
			})

			if ((config as CommandConfig).sage !== undefined) {
				value.sage = (config as CommandConfig).sage
			}
		}
	}
	if (type === 'events' && config) {
		value.frequency = (config as EventConfig).frequency ?? 'always'
	}

	if (config.timeout !== undefined) {
		value.timeout = config.timeout
	}

	// Sort values order by key
	return Object.keys(value)
		.sort()
		.reduce((acc, key) => {
			acc[key as keyof T] = value[key as keyof T]
			return acc
		}, {} as T)
}

/**
 * We should not include plugin option values in the manifest.
 * They may contain sensitive information such as API keys or passwords.
 */
function redactPluginOptions(config: Config): Config {
	if (!config.plugins) {
		return config
	}

	const redactedPlugins = config.plugins?.map((plugin): Plugin => {
		if (Array.isArray(plugin)) {
			const [pluginName, pluginOptions] = plugin

			if (typeof pluginOptions === 'object') {
				const redactedObj: Record<string, unknown> = {}

				for (const key in pluginOptions as Record<string, unknown>) {
					if (Object.prototype.hasOwnProperty.call(pluginOptions as Record<string, unknown>, key)) {
						redactedObj[key] = '[REDACTED]'
					}
				}

				return [pluginName, redactedObj]
			}
		}

		return plugin
	})

	return {
		...config,
		plugins: redactedPlugins
	}
}
