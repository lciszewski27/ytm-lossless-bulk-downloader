# YouTube to Tidal Lossless Downloader

A high-performance CLI tool built with **Bun** that automates the process of finding and downloading lossless (FLAC) versions of YouTube tracks/playlists using Tidal search instances.

## 🚀 Features

- **Lossless Downloads**: Automatically searches Tidal instances for FLAC versions of YouTube songs.
- **Metadata Tagging**: Uses `ffmpeg` to embed high-quality thumbnails and metadata (Artist, Title) from YouTube into the downloaded file.
- **Smart Fallback**: If a track isn't found on Tidal, it offers to download the audio directly from YouTube Music (128kbps).
- **Load Balancing**: Shuffles multiple Tidal instances to prevent over-loading a single server.
- **Extended Filename Mode**: Use the `-e` flag to include BPM, Key, and Audio Quality directly in the filename.
- **Dependency Checks**: Automatic verification of required tools at startup.

## 📋 Prerequisites

Before running the script, ensure you have the following installed:

1.  **Bun**: [Installation Guide](https://bun.sh)
2.  **yt-dlp**: Required for metadata fetching and fallback downloads.
3.  **ffmpeg**: Required for audio tagging and thumbnail embedding.

## 🛠️ Installation

1.  Clone this repository or copy the `index.ts` file to your project folder.
2.  Install dependencies:
    ```bash
    bun init -y
    ```

## 📖 Usage

Run the script using `bun`:

```bash
bun run index.ts <youtube_url> [destination_folder] [flags]
```
