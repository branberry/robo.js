import React, { useEffect } from 'react'
import Layout from '@theme/Layout'
import sdk from '@stackblitz/sdk'
import Head from '@docusaurus/Head'

const OgImage = 'https://robojs.dev/playground/og-image.png'

function Playground() {
	useEffect(() => {
		sdk.embedGithubProject('embed', 'Wave-Play/robo.js/tree/main/templates/web-apps/react-ts', {
			devToolsHeight: 40,
			openFile: ['src/api/get-count.ts,src/api/set-count.ts,src/app/App.tsx'],
			showSidebar: true,
			terminalHeight: 40,
			theme: 'dark',
			view: 'default'
		})
	}, [])

	return <div id={'embed'} />
}

export default function Home() {
	return (
		<Layout title={`Playground`} description="Try out Robo.js in your browser!">
			<Head>
				<meta property="og:image" content={OgImage} />
				<meta property="og:image:width" content="1200" />
				<meta property="og:image:height" content="600" />
				<meta property="twitter:image" content={OgImage} />
			</Head>
			<main
				style={{
					width: '100%',
					height: 'calc(100vh - 64px)',
					display: 'flex',
					justifyContent: 'center',
					alignItems: 'center'
				}}
			>
				<Playground />
			</main>
		</Layout>
	)
}
