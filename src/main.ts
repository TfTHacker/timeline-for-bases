import { App, Notice, Plugin, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import { TimelineView } from './timeline-view';

interface TimelinePluginSettings {
	defaultWeekStart: 'monday' | 'sunday';
}

const DEFAULT_SETTINGS: TimelinePluginSettings = {
	defaultWeekStart: 'monday',
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

		this.addSettingTab(new TimelineSettingTab(this.app, this));
	}

	async createSampleBase(): Promise<void> {
		const folder = 'Timeline Sample';
		const basePath = normalizePath(`${folder}/Family Vacation Planning.base`);

		// Create folder
		if (!await this.app.vault.adapter.exists(folder)) {
			await this.app.vault.createFolder(folder);
		}

		// Generate 10 vacation planning tasks relative to today
		const today = new Date();
		const fmt = (d: Date) => d.toISOString().slice(0, 10);
		const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

		const tasks: { name: string; start: number; duration: number; priority: 'High' | 'Medium' | 'Low' }[] = [
			{ name: 'Set vacation budget',            start: 0,  duration: 3,  priority: 'High'   },
			{ name: 'Choose destination',             start: 2,  duration: 4,  priority: 'High'   },
			{ name: 'Research accommodation options', start: 5,  duration: 5,  priority: 'Medium' },
			{ name: 'Book flights',                   start: 8,  duration: 2,  priority: 'High'   },
			{ name: 'Book accommodation',             start: 10, duration: 2,  priority: 'High'   },
			{ name: 'Plan daily itinerary',           start: 12, duration: 7,  priority: 'Medium' },
			{ name: 'Arrange pet care',               start: 14, duration: 3,  priority: 'Medium' },
			{ name: 'Pack luggage',                   start: 25, duration: 2,  priority: 'Low'    },
			{ name: 'Confirm all bookings',           start: 20, duration: 1,  priority: 'High'   },
			{ name: 'Purchase travel insurance',      start: 6,  duration: 1,  priority: 'Low'    },
		];

		for (const task of tasks) {
			const startDate = addDays(today, task.start);
			const endDate = addDays(today, task.start + task.duration);
			const filePath = normalizePath(`${folder}/${task.name}.md`);
			const content = `---\nstart: ${fmt(startDate)}\nend: ${fmt(endDate)}\npriority: ${task.priority}\nstatus: open\n---\n\n# ${task.name}\n`;
			if (!await this.app.vault.adapter.exists(filePath)) {
				await this.app.vault.create(filePath, content);
			}
		}

		// Create the .base file
		const baseContent = `filters:
  and:
    - "!start.isEmpty()"
views:
  - type: timeline
    name: Family Vacation Planning
    filters:
      and:
        - file.folder == "${folder}"
    sort:
      - property: start
        direction: ASC
    startDate: note.start
    endDate: note.end
    label: note.title
    colorBy: note.priority
    colorMap:
      High: "#e03131"
      Medium: "#f59f00"
      Low: "#2f9e44"
    timeScale: day
    zoom: 1
`;
		if (!await this.app.vault.adapter.exists(basePath)) {
			await this.app.vault.create(basePath, baseContent);
		}

		new Notice(`Sample base created in "${folder}" — open Family Vacation Planning.base to view.`);

		// Open the base file
		const file = this.app.vault.getFileByPath(basePath);
		if (file) {
			await this.app.workspace.getLeaf(false).openFile(file);
		}
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
			.setName('Create sample base')
			.setDesc('Creates a "Timeline Sample" folder in your vault with 10 family vacation planning tasks and a ready-to-use Timeline base. Tasks use today\'s date as the starting point.')
			.addButton(btn => btn
				.setButtonText('Create sample')
				.setCta()
				.onClick(async () => {
					btn.setDisabled(true);
					btn.setButtonText('Creating…');
					try {
						await this.plugin.createSampleBase();
					} finally {
						btn.setDisabled(false);
						btn.setButtonText('Create sample');
					}
				}));
	}
}
