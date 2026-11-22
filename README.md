# Tools to Share

Start with the directory below, choose a tool, and follow its README. There is no shared installation step: requirements and supported operating systems depend on the tool.

## Available tools

| Tool | What it does | Platform | Documentation |
| --- | --- | --- | --- |
| [Local Photo Organizer](./photo-organizer/) | Find photos by content, date, GPS proximity, or visual similarity; review duplicates; copy or move selected files into ordinary folders on your disk. Analysis runs locally. | macOS 15+, Node.js 22+, Apple Command Line Tools | [Installation and usage](./photo-organizer/README.md) |

More tools will be added to this directory as they are shared.

## Getting started

1. Clone the repository and open the folder for the tool you want to use.
2. Read that tool's README and install its requirements.
3. Run the commands from inside that tool's folder, not from the repository root.

For Photo Organizer, after installing its requirements:

```bash
git clone https://github.com/Marcelrama/tools.git tool-to-share
cd tool-to-share/photo-organizer
npm run check
npm start
```

Photo Organizer has no external npm dependencies, so `npm install` is not required. Other tools may have different installation steps.

See the [complete Photo Organizer guide](./photo-organizer/README.md) for first-time installation, supported formats, data storage, and troubleshooting.

## Repository structure

```text
tool-to-share/
├── README.md
├── .gitignore
└── photo-organizer/
    ├── README.md
    ├── LICENSE
    ├── package.json
    ├── index.html
    ├── js/
    │   ├── app.js
    │   └── server.mjs
    ├── css/
    │   └── styles.css
    ├── vision.swift
    ├── scripts/
    └── test/
```

## Licenses and local data

Check the license inside each tool's folder before using or redistributing it. Photo Organizer is available under the [MIT License](./photo-organizer/LICENSE). Requirements or licenses for system frameworks and third-party components remain separate.

The root `.gitignore` excludes dependency folders, local environment files, logs, caches covered by its rules, and Photo Organizer indexes and JSON backups throughout the repository. Keep personal photos and other private files outside this repository; ignore rules do not automatically protect every kind of personal data or files already tracked by Git.
