# Local Photo Organizer

[← All tools](../README.md)

Find and organize photos directly in folders on your hard drive or an external drive. Search by content, date, location, and visual similarity, review duplicates, and copy or move selected photos into other folders.

The idea is to offer a photo browsing experience inspired by Apple Photos while keeping your files in ordinary folders you can open in Finder. You do not need to import them into a managed photo library or upload them to the cloud. This is not a replica of Photos: it does not use its catalog, albums, or people index, and it does not guarantee the same results. Image recognition runs locally using Apple Vision.

## Compatibility and requirements

- **macOS 15 or later.** This version uses Apple Vision, ImageIO, `sips`, Finder, and `/usr/bin/trash`. Windows and Linux are not supported without replacing those integrations.
- **Node.js 22 or later**, including npm.
- **Apple Command Line Tools**, including the Swift compiler and the required SDKs. The full Xcode application is not required.
- A desktop browser and enough free storage for thumbnails, indexes, and any photo copies you create.
- Read access to source folders and write access wherever you save indexes or files.

No account, API key, subscription, or third-party npm packages are required. Internet access is needed to download the project and install the tools; photo analysis runs locally.

Each person installs and runs their own copy on their Mac. This version has no accounts or isolated sessions and is not designed for multiple people connecting to a shared server. Do not expose it as a network service.

## Step-by-step installation

### 1. Check macOS

Open **About This Mac** from the Apple menu and check the version. Alternatively, open Terminal and run:

```bash
sw_vers -productVersion
```

### 2. Install Node.js

Download a macOS installer from [nodejs.org](https://nodejs.org/), choosing an LTS release numbered 22 or later. Complete the installation, open a new Terminal window, and check:

```bash
node --version
npm --version
```

### 3. Install Apple Command Line Tools

Run this in Terminal:

```bash
xcode-select --install
```

Accept the installation and wait for it to finish. If macOS reports that the tools are already installed, continue. Check that Swift is available:

```bash
xcrun --find swiftc
swiftc --version
```

### 4. Clone the repository

Run in Terminal:

```bash
cd ~/Desktop
git clone https://github.com/Marcelrama/tools.git tool-to-share
cd tool-to-share/photo-organizer
```

If you already cloned the repository, open its `photo-organizer` folder instead.

You do not need to run `npm install`: this tool has no external npm dependencies. Node.js runs the server directly, and image recognition uses the Apple frameworks installed on your Mac.

### 5. Check requirements and start

```bash
npm run check
npm start
```

Your browser opens at **http://127.0.0.1:4321/**. Keep Terminal open while using the tool. To stop it, return to Terminal and press **Control + C**.

The first time you analyze content or metadata, the small Swift helper is compiled locally. This may take longer than subsequent runs.

After checking the requirements, you can also open a folder directly from Terminal:

```bash
node js/server.mjs "$HOME/Pictures/My photos"
```

Use quotation marks around paths containing spaces.

## First use

The interface and predefined content search terms are in English.

1. Open a photo folder using the folder picker or enter its path. You can choose an external drive mounted under `/Volumes/`.
2. Start the analysis. Photos in the selected folder and its subfolders are scanned. Content recognition continues in the background.
3. Search using terms such as `beach`, `mountain`, `night`, `street`, or `people`. Search also considers file and folder names.
4. Use **More like this** to sort by content similarity. You can add several example photos.
5. Use **Same day** or **Same place** to narrow results when the necessary metadata is available.
6. Create a category and choose its destination folder. Select photos and choose **Copy** to keep the originals in place, or **Move** to relocate them.

Search uses labels and predefined terms. It is not a chat interface or a search engine that understands arbitrary sentences. Recognition can be wrong. The search vocabulary is defined in `WORDS` in `js/app.js`.

### Dates and locations

Dates come from metadata or, in some cases, file names. **Same place** groups nearby photos using available GPS coordinates. It does not automatically identify every city worldwide or query online maps.

No predefined place names or regional coordinates are included. “Same place” compares the GPS coordinates of your selected photo with those of other photos. Without GPS data, this filter cannot determine where a photo was taken. Developers may optionally configure their own named places in `PLACES` in `js/app.js`.

### Duplicates and file operations

- Identical copies are detected using SHA-256. The tool suggests keeping one photo per group.
- Similar photos are visual suggestions: review them before deleting anything. They are not automatically selected as identical copies.
- Deleting sends files to the macOS Trash. Keep a separate backup and review your selection.
- Copying preserves the originals; moving changes their location. If a destination file name already exists, a suffix is added instead of overwriting it.
- Use a test folder for your first session. Do not select the contents of a `.photoslibrary` package. If your photos exist only in Apple Photos, export them to an ordinary folder first.

### File formats

The scanner recognizes AVIF, BMP, GIF, HEIC/HEIF, JPEG, NEF, PNG, TIFF, and WebP extensions. Recognizing an extension does not guarantee that every file of that type can be decoded: previews and analysis depend on macOS support. Damaged or unsupported files may have no preview or labels. This version does not organize videos.

## Where data is stored

Originals remain in their folders until you choose to move or delete them. The tool also writes supporting files:

| Location | Contents |
| --- | --- |
| Selected folder: `photo-organizer-indice.json` | Photo index, analysis results, and categories. |
| Selected folder: `photo-organizer-vision.json` | Labels, content fingerprints, and metadata. |
| `~/Library/Caches/photo-organizer/` | Thumbnails and the compiled Swift helper. |
| Browser local storage | The last folder used. |

The index lets you reopen a folder without repeating the entire analysis. You can export and import JSON backups created by this version. New or modified photos are analyzed again.

Indexes and backups may contain paths, file names, and GPS locations. Treat them as personal data and do not include them in a public repository. This distribution contains no author photos, indexes, or backups.

This standalone edition uses the `local-photo-organizer` index format. It does not automatically import indexes with other format identifiers.

## Troubleshooting

**Port already in use:** close another running instance or use:

```bash
PORT=4322 npm start
```

Open the address printed in Terminal. Each instance maintains one active folder.

**Browser does not open:** enter the local address manually. To start without automatically opening a browser:

```bash
NO_OPEN=1 npm start
```

**Recognition is unavailable:** check `npm run check` and `swiftc --version`. The initial compilation requires Apple tools compatible with your macOS version. After a system update, you may also need to update Command Line Tools.

**Access denied:** check permissions for Terminal or the application used to start Node under System Settings → Privacy & Security → Files and Folders. Also check that the drive is connected and writable. Do not run the server with `sudo`.

**Search does not find a concept:** wait for recognition to finish, try a more general supported term, or use an example image. The tool does not identify people by name or index your Apple Photos library.

## Development checks

```bash
npm test
```

Tests create a temporary folder and do not use your photo collection. The server and interface are written in JavaScript; `vision.swift` handles recognition and metadata using Apple frameworks.

## Project status and distribution

A local tool for individual use on each Mac. It does not include synchronization, accounts, cloud hosting, or shared multiuser support. The server listens only on `127.0.0.1` and runs with the permissions of the user who starts it.

The code in this repository is distributed under the MIT License; see `LICENSE`. You may use, modify, and redistribute it while retaining the copyright and license notices. This does not grant rights to Apple frameworks: each user installs Apple tools through official channels. No Apple SDKs, frameworks, or models are redistributed.

Official references: [Vision](https://developer.apple.com/documentation/vision) and the [Xcode and Apple SDKs Agreement](https://www.apple.com/legal/sla/docs/xcode.pdf).

## License scope and relationship with Apple

This is an independent project, not affiliated with, sponsored by, or approved by Apple. References to macOS, Photos, and Vision describe compatibility and differences; they do not imply that this tool reproduces the internal workings of Photos.

The distribution contains the tool's source code, including `vision.swift`, which calls public Apple APIs. It does not include Apple's SDK, frameworks, recognition models, or executables. Users obtain the official tools and compile the helper locally on their Macs. MIT applies to this project's code, not to Apple components or users' photos.

Sections 2.4 and 2.6 of the Xcode and Apple SDKs Agreement address distribution of macOS applications and libraries under its terms and distinguish ownership of those applications from ownership of Apple software. Sections 2.5 and 2.7 restrict copying or redistributing Apple software and running it on non-Apple hardware. These terms do not authorize extracting Vision models, redistributing the SDK, or porting Apple frameworks to other operating systems. Consult the official agreement linked above.

The review of this copy checked the distributed files and declared dependencies. It is not a legal certification or proof of authorship for every code fragment. Any third-party material added in the future requires a license review before inclusion.
