import { Treats } from '../core/data.js'
import { createCommandConfig, Flashcore } from 'robo.js'

export const config = createCommandConfig({
	description: 'Take a treat and sell it',
	options: [
		{
			name: 'treat',
			description: 'The treat to take and sell',
			required: true,
			choices: Treats.map((treat) => ({
				name: treat.name,
				value: treat.name.toLowerCase()
			}))
		}
	]
})

export default async (interaction, options) => {
	const { treat } = options
	const balance = (await Flashcore.get('balance', { namespace: interaction.user.id })) ?? 0
	const inventory = (await Flashcore.get('inventory', { namespace: interaction.user.id })) ?? []

	// Check if the user has the treat
	const treatIndex = inventory.findIndex((t) => t.name.toLowerCase() === treat)

	if (treatIndex === -1) {
		return {
			content: 'You do not have that treat in your inventory!',
			ephemeral: true
		}
	}

	// Sell the treat
	const selected = inventory.splice(treatIndex, 1)[0]
	await Flashcore.set('inventory', inventory, { namespace: interaction.user.id })
	await Flashcore.set('balance', balance + selected.price, { namespace: interaction.user.id })

	return `${interaction.member} took a ${treat} and sold it for $${selected.price}! 💰`
}