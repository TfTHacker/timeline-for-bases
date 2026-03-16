import { App, Notice, Plugin, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import { TimelineView } from './timeline-view';

interface TimelinePluginSettings {
	defaultWeekStart: 'monday' | 'sunday';
	defaultDensity: 'comfortable' | 'compact';
}

const DEFAULT_SETTINGS: TimelinePluginSettings = {
	defaultWeekStart: 'monday',
	defaultDensity: 'comfortable',
};

export default class TimelinePlugin extends Plugin {
	settings: TimelinePluginSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();
		this.registerBasesView('timeline', {
			name: 'Timeline',
			icon: 'lucide-calendar-range',
			factory: (controller, containerEl) => new TimelineView(controller, containerEl, this),
			options: TimelineView.getViewOptions,
		});

		this.addCommand({
			id: 'timeline-capture-current-view',
			name: 'Timeline: Capture current view screenshot',
			callback: async () => {
				await this.captureTimelineScreenshot();
			},
		});

		this.addSettingTab(new TimelineSettingTab(this.app, this));
	}

	private async captureTimelineScreenshot(): Promise<void> {
		const timelineEl = document.querySelector('.bases-timeline-view') as HTMLElement | null;
		if (!timelineEl) {
			new Notice('Timeline view not found. Open a Timeline view first.');
			return;
		}

		try {
			const html2canvas = (await import('html2canvas')).default;
			const canvas = await html2canvas(timelineEl, {
				backgroundColor: null,
				scale: window.devicePixelRatio || 1,
				useCORS: true,
			});

			const dataUrl = canvas.toDataURL('image/png');
			const bytes = this.dataUrlToBytes(dataUrl);
			const filePath = normalizePath(`Screenshots/timeline-${Date.now()}.png`);

			await this.app.vault.adapter.mkdir('Screenshots').catch(() => {});
			await this.app.vault.adapter.writeBinary(filePath, bytes.buffer as ArrayBuffer);

			new Notice(`Timeline screenshot saved: ${filePath}`);
		} catch (error) {
			console.error('Timeline screenshot failed:', error);
			new Notice('Timeline screenshot failed. Check console for details.');
		}
	}

	private dataUrlToBytes(dataUrl: string): Uint8Array {
		const base64 = dataUrl.split(',')[1] || '';
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	onunload() {
	}
}

class TimelineSettingTab extends PluginSettingTab {
	plugin: TimelinePlugin;

	constructor(app: App, plugin: TimelinePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Default week starts on')
			.setDesc('Used by Timeline views unless overridden in the view options.')
			.addDropdown(dropdown => dropdown
				.addOption('monday', 'Monday')
				.addOption('sunday', 'Sunday')
				.setValue(this.plugin.settings.defaultWeekStart)
				.onChange(async (value: 'monday' | 'sunday') => {
					this.plugin.settings.defaultWeekStart = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Default density')
			.setDesc('Comfortable or compact row spacing.')
			.addDropdown(dropdown => dropdown
				.addOption('comfortable', 'Comfortable')
				.addOption('compact', 'Compact')
				.setValue(this.plugin.settings.defaultDensity)
				.onChange(async (value: 'comfortable' | 'compact') => {
					this.plugin.settings.defaultDensity = value;
					await this.plugin.saveSettings();
				}));
	}
}
