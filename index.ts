import { spawnSync } from "bun";
import fs from "fs";
import path from "path";

// --- INTERFACES ---

interface TidalTrack {
  id: number;
  title: string;
  duration: number;
  bpm: number | null;
  key: string | null;
  keyScale: "MAJOR" | "MINOR" | null;
  audioQuality: string;
  album: {
    id: number;
    title: string;
    cover: string; // UUID okładki
  };
}

interface YTTrack {
  title: string;
  author: string;
  duration: number;
  url: string;
  thumbnail: string;
}

// --- PRE-FLIGHT ---
function checkDependencies(): void {
  const tools = [
    { n: "yt-dlp", f: "--version" },
    { n: "ffmpeg", f: "-version" },
  ];
  for (const t of tools) {
    if (
      spawnSync([t.n, t.f], { stdio: ["ignore", "ignore", "ignore"] })
        .exitCode !== 0
    ) {
      console.error(`❌ Missing: ${t.n}`);
      process.exit(1);
    }
  }
}
checkDependencies();

// --- HELPERS ---

/**
 * Konwertuje UUID okładki Tidala na pełny URL
 * Format: https://resources.tidal.com/images/{part1}/{part2}/{part3}/{part4}/{part5}/1280x1280.jpg
 */
function getTidalCoverUrl(uuid: string): string | null {
  if (!uuid || uuid.length < 32) return null;
  const parts = uuid.split("-");
  if (parts.length !== 5)
    return `https://resources.tidal.com/images/${uuid.replace(/-/g, "/")}/1280x1280.jpg`; // fallback
  return `https://resources.tidal.com/images/${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}/${parts[4]}/1280x1280.jpg`;
}

function applyMetadata(
  filePath: string,
  track: YTTrack,
  coverUrl: string,
): void {
  const ext = path.extname(filePath);
  const tempPath = filePath.replace(ext, `.temp${ext}`);

  const ffmpegArgs = [
    "-y",
    "-i",
    filePath,
    "-i",
    coverUrl,
    "-map",
    "0:0",
    "-map",
    "1:0",
    "-c:a",
    "copy",
    "-c:v",
    "mjpeg",
    "-pix_fmt",
    "yuvj420p",
    "-metadata",
    `title=${track.title}`,
    "-metadata",
    `artist=${track.author}`,
    "-metadata",
    `comment=From tidal`,
    "-disposition:v",
    "attached_pic",
    tempPath,
  ];

  const res = spawnSync(["ffmpeg", ...ffmpegArgs], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (res.exitCode === 0) fs.renameSync(tempPath, filePath);
  else if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}

// --- MAIN LOGIC ---

const args = process.argv.slice(2);
const isExtended = args.includes("-e");
const filteredArgs = args.filter((a) => a !== "-e");
const SOURCE_URL = filteredArgs[0];
const DOWNLOAD_DIR = filteredArgs[1]
  ? path.resolve(filteredArgs[1])
  : process.cwd();

if (!SOURCE_URL) {
  console.error("Usage: bun run index.ts <url> [folder] [-e]");
  process.exit(1);
}
if (!fs.existsSync(DOWNLOAD_DIR))
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

async function downloadWithFailover(track: YTTrack) {
  const query = `${track.title} ${track.author}`.replace(/[()]/g, "");
  const instances = [
    "https://ohio-1.monochrome.tf",
    "https://hifi-two.spotisaver.net",
    "https://singapore-1.monochrome.tf",
    "https://hfapi.aluratech.org",
    "https://eu-central.monochrome.tf",
    "https://katze.qqdl.site",
    "https://api.monochrome.tf",
  ];

  for (const baseUrl of instances) {
    try {
      console.log(`🔍 [${baseUrl}] Searching...`);
      const searchRes = await fetch(
        `${baseUrl}/search?s=${encodeURIComponent(query)}`,
      );
      const searchData = await searchRes.json();
      const matched = (searchData.data?.items as TidalTrack[])?.find(
        (i) => Math.abs(i.duration - track.duration) <= 5,
      );

      if (!matched) continue;

      const streamRes = await fetch(
        `${baseUrl}/track?id=${matched.id}&quality=LOSSLESS`,
      );
      const streamData = await streamRes.json();
      const manifestBase64 = streamData.data?.manifest || streamData.manifest;
      if (!manifestBase64) continue;

      const manifest = JSON.parse(
        Buffer.from(manifestBase64, "base64").toString(),
      );
      const audioUrl = manifest?.urls?.[0];

      if (audioUrl) {
        const ext = audioUrl.toLowerCase().includes(".flac") ? "flac" : "m4a";
        let fileName = track.author + " - " + track.title;
        if (isExtended) {
          fileName += ` [${matched.bpm || 0} BPM] [${matched.key || "?"}${matched.keyScale === "MINOR" ? "m" : ""}] [${matched.audioQuality}]`;
        }

        const filePath = path.join(
          DOWNLOAD_DIR,
          sanitize(fileName) + "." + ext,
        );
        console.log(`📥 Downloading: ${path.basename(filePath)}`);

        const fileRes = await fetch(audioUrl);
        await Bun.write(filePath, await fileRes.arrayBuffer());

        // WYBÓR OKŁADKI: Tidal (High Res) -> YT
        const tidalCover = matched.album?.cover
          ? getTidalCoverUrl(matched.album.cover)
          : null;
        const finalCover = tidalCover || track.thumbnail;

        console.log(
          `🏷️  Applying ${tidalCover ? "Tidal" : "YouTube"} Cover...`,
        );
        applyMetadata(filePath, track, finalCover);

        console.log(`✅ Success!`);
        return true;
      }
    } catch (e) {
      console.error(`❌ Error on ${baseUrl}`);
    }
  }
  return false;
}

// --- RUN ---
console.log("⏳ Fetching metadata...");
const proc = spawnSync([
  "yt-dlp",
  "--flat-playlist",
  "--print",
  "%(title)s|%(uploader)s|%(duration)s|%(webpage_url)s|%(thumbnail)s",
  SOURCE_URL,
]);
const tracks: YTTrack[] = proc.stdout
  .toString()
  .trim()
  .split("\n")
  .map((line) => {
    const [title, author, duration, url, thumbnail] = line.split("|");
    return { title, author, duration: parseInt(duration), url, thumbnail };
  });

for (let i = 0; i < tracks.length; i++) {
  console.log(`\n🎵 [${i + 1}/${tracks.length}] ${tracks[i].title}`);
  await downloadWithFailover(tracks[i]);
  await new Promise((r) => setTimeout(r, 1000));
}

function sanitize(s: string) {
  return s.replace(/[<>:"/\\|?*]/g, "").trim();
}
