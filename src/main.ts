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
		const folder     = 'Timeline Sample';
		const notesFolder = `${folder}/Notes`;
		const basePath   = normalizePath(`${folder}/Family Vacation Planning.base`);

		// Create folders
		if (!await this.app.vault.adapter.exists(folder)) {
			await this.app.vault.createFolder(folder);
		}
		if (!await this.app.vault.adapter.exists(notesFolder)) {
			await this.app.vault.createFolder(notesFolder);
		}

		// Generate 20 vacation planning tasks relative to today
		// Parallel groups are intentional: days 0-1 (budget+passports), 6-9 (flights+accommodation research),
		// 12-13 (book flights+accommodation), 22-24 (pet care+house sitter), 29-30 (pack+confirm)
		const today = new Date();
		const fmt = (d: Date) => d.toISOString().slice(0, 10);
		const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

		const tasks: { name: string; start: number; duration: number; priority: 'High' | 'Medium' | 'Low' }[] = [
			// Week 1 — foundations (budget + passports run in parallel)
			{ name: 'Set vacation budget',             start: 0,  duration: 4,  priority: 'High'   },
			{ name: 'Check passport validity',         start: 0,  duration: 2,  priority: 'High'   },
			{ name: 'Choose destination',              start: 3,  duration: 4,  priority: 'High'   },
			{ name: 'Agree on travel dates',           start: 3,  duration: 2,  priority: 'Medium' },
			// Week 2 — research phase (flights + accommodation researched in parallel)
			{ name: 'Research flights',                start: 6,  duration: 4,  priority: 'Medium' },
			{ name: 'Research accommodation options',  start: 6,  duration: 5,  priority: 'Medium' },
			{ name: 'Apply for visas if required',     start: 7,  duration: 10, priority: 'High'   },
			{ name: 'Get travel vaccinations',         start: 8,  duration: 3,  priority: 'Medium' },
			// Week 2–3 — bookings (flights + accommodation booked in parallel)
			{ name: 'Book flights',                    start: 12, duration: 2,  priority: 'High'   },
			{ name: 'Book accommodation',              start: 12, duration: 2,  priority: 'High'   },
			{ name: 'Purchase travel insurance',       start: 14, duration: 2,  priority: 'High'   },
			// Week 3 — planning
			{ name: 'Plan daily itinerary',            start: 17, duration: 7,  priority: 'Medium' },
			{ name: 'Research local transport',        start: 17, duration: 4,  priority: 'Low'    },
			{ name: 'Book tours and activities',       start: 21, duration: 4,  priority: 'Medium' },
			// Week 4 — logistics (pet care + house sitter arranged in parallel)
			{ name: 'Arrange pet care',                start: 22, duration: 3,  priority: 'Medium' },
			{ name: 'Arrange house sitter',            start: 22, duration: 3,  priority: 'Low'    },
			{ name: 'Notify bank of travel dates',     start: 25, duration: 1,  priority: 'Low'    },
			{ name: 'Buy travel accessories',          start: 25, duration: 3,  priority: 'Low'    },
			// Final days (packing + confirm bookings run in parallel)
			{ name: 'Pack luggage',                    start: 29, duration: 2,  priority: 'Low'    },
			{ name: 'Confirm all bookings',            start: 29, duration: 1,  priority: 'High'   },
		];

		for (const task of tasks) {
			const startDate = addDays(today, task.start);
			const endDate = addDays(today, task.start + task.duration);
			const filePath = normalizePath(`${notesFolder}/${task.name}.md`);
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
        - file.folder == "${notesFolder}"
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
