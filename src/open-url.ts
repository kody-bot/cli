import { spawn } from 'node:child_process'

export async function openUrl(url: string): Promise<boolean> {
	const platform = process.platform
	const command =
		platform === 'darwin'
			? 'open'
			: platform === 'win32'
				? 'cmd'
				: 'xdg-open'
	const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
	return await new Promise((resolve) => {
		const child = spawn(command, args, {
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
		})
		child.on('error', () => resolve(false))
		child.unref()
		resolve(true)
	})
}
