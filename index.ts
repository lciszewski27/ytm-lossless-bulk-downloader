import { spawnSync } from "bun";
import fs from "fs";
import path from "path";

// --- INTERFACES ---

interface YTTrack {
  title: string;
  author: string;
  duration: number;
  url: string;
  thumbnail: string;
}

// --- PRE-FLIGHT CHECKS ---
function checkDependencies() {
  const tools = [
    { name: "yt-dlp", flag: "--version" },
    { name: "ffmpeg", flag: "-version" },
  ];
  for (const tool of tools) {
    const check = spawnSync([tool.name, tool.flag], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (check.exitCode !== 0) {
      console.error(`\n❌ ERROR: "${tool.name}" is not installed.`);
      process.exit(1);
    }
  }
}

checkDependencies();

// --- CONFIGURATION ---
const INSTANCES = ["https://ohio-1.monochrome.tf", "https://monochrome.tf"];
let deadInstances = new Set<string>();

const args = process.argv.slice(2);
const isExtended = args.includes("-e");
const filteredArgs = args.filter((a) => a !== "-e");

const SOURCE_URL = filteredArgs[0];
const DOWNLOAD_DIR = filteredArgs[1]
  ? path.resolve(filteredArgs[1])
  : process.cwd();

if (!SOURCE_URL) {
  console.error("Usage: bun run index.ts <youtube_url> [folder] [-e]");
  process.exit(1);
}

if (!fs.existsSync(DOWNLOAD_DIR))
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// --- HELPERS ---
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function shuffle<T>(array: T[]): T[] {
  const newArr = [...array];
  for (let i = newArr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
  }
  return newArr;
}

function sanitize(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Konwertuje UUID okładki Tidala na pełny URL 1280x1280
 */
function getTidalCoverUrl(uuid: string): string | null {
  if (!uuid) return null;
  const parts = uuid.split("-");
  if (parts.length !== 5) return null;
  return `https://resources.tidal.com/images/${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}/${parts[4]}/1280x1280.jpg`;
}

function applyMetadata(filePath: string, track: YTTrack, thumbnailUrl: string) {
  const ext = path.extname(filePath);
  const tempPath = filePath.replace(ext, `.temp${ext}`);

  const ffmpegArgs = [
    "-y",
    "-i",
    filePath,
    "-i",
    thumbnailUrl,
    "-map",
    "0:0",
    "-map",
    "1:0",
    "-c:a",
    "copy",
    "-c:v",
    "mjpeg", // Konwersja okładki na MJPEG dla kompatybilności
    "-pix_fmt",
    "yuvj420p", // Naprawa profilu kolorów
    "-metadata",
    `title=${track.title}`,
    "-metadata",
    `artist=${track.author}`,
    "-metadata",
    `comment=Lossless via Gemini`,
    "-disposition:v",
    "attached_pic",
    tempPath,
  ];

  const res = spawnSync(["ffmpeg", ...ffmpegArgs], {
    stdio: ["ignore", "ignore", "ignore"],
  });

  if (res.exitCode === 0) {
    fs.renameSync(tempPath, filePath);
  } else {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function getMetadata(url: string): YTTrack[] {
  console.log("⏳ Fetching metadata...");
  const proc = spawnSync(
    [
      "yt-dlp",
      "--flat-playlist",
      "--print",
      "%(title)s|%(uploader)s|%(duration)s|%(webpage_url)s|%(thumbnail)s",
      url,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const output = proc.stdout.toString().trim();
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [title, author, duration, webpage_url, thumb] = line.split("|");
    return {
      title,
      author,
      duration: parseInt(duration) || 0,
      url: webpage_url,
      thumbnail: thumb,
    };
  });
}

async function downloadWithFailover(
  track: YTTrack,
): Promise<{ success: boolean; fatal: boolean }> {
  const query = `${track.title} ${track.author}`.replace(/[()]/g, "");
  let available = shuffle(INSTANCES.filter((inst) => !deadInstances.has(inst)));

  if (available.length === 0) return { success: false, fatal: true };

  for (const baseUrl of available) {
    try {
      console.log(`🔍 [${baseUrl}] Searching...`);
      const searchRes = await fetch(
        `${baseUrl}/search?s=${encodeURIComponent(query)}`,
        { signal: AbortSignal.timeout(10000) },
      );
      const searchData = await searchRes.json();

      const items = searchData.data?.items || [];
      const matched = items.find(
        (item: any) => Math.abs(item.duration - track.duration) <= 5,
      );

      if (!matched) continue;

      const streamRes = await fetch(
        `${baseUrl}/track?id=${matched.id}&quality=LOSSLESS`,
        { signal: AbortSignal.timeout(15000) },
      );
      const streamData = await streamRes.json();
      const data = streamData.data || streamData;

      if (!data.manifest) continue;
      const manifest = JSON.parse(
        Buffer.from(data.manifest, "base64").toString(),
      );
      const audioUrl = manifest?.urls?.[0];

      if (audioUrl) {
        const ext = audioUrl.toLowerCase().includes(".flac") ? "flac" : "m4a";
        let fileName = sanitize(`${track.author} - ${track.title}`);

        if (isExtended) {
          const bpm = matched.bpm || "0";
          const key = matched.key || "Unknown";
          const scale = matched.keyScale || "";
          const quality = matched.audioQuality || "LOSSLESS";
          fileName += ` [${bpm} BPM] [${key} ${scale}] [${quality}]`;
        }

        const filePath = path.join(DOWNLOAD_DIR, `${fileName}.${ext}`);
        console.log(`📥 Downloading: ${fileName}.${ext}`);

        const fileRes = await fetch(audioUrl);
        const buffer = await fileRes.arrayBuffer();
        await Bun.write(filePath, buffer);

        // WYBÓR OKŁADKI: Tidal (UUID) -> Fallback YT
        const tidalCover = matched.album?.cover
          ? getTidalCoverUrl(matched.album.cover)
          : null;
        const finalCover = tidalCover || track.thumbnail;

        console.log(
          `🏷️  Applying ${tidalCover ? "Official Tidal" : "YouTube"} tags...`,
        );
        applyMetadata(filePath, track, finalCover);

        console.log(`✅ Success!`);
        return { success: true, fatal: false };
      }
    } catch (e: any) {
      console.error(`❌ Instance Error (${baseUrl}): ${e.message}`);
      deadInstances.add(baseUrl);
    }
  }
  return { success: false, fatal: false };
}

async function main() {
  const allTracks = getMetadata(SOURCE_URL);
  if (allTracks.length === 0) return;

  console.log(
    `📋 Queue: ${allTracks.length} tracks. Extended: ${isExtended ? "ON" : "OFF"}`,
  );
  const failedTracks: YTTrack[] = [];

  for (let i = 0; i < allTracks.length; i++) {
    const track = allTracks[i];
    console.log(`\n🎵 [${i + 1}/${allTracks.length}] ${track.title}`);
    const result = await downloadWithFailover(track);

    if (!result.success) {
      failedTracks.push(track);
      if (result.fatal) {
        console.error("🚨 All instances are offline. Stopping.");
        break;
      }
    }
    await sleep(800);
  }

  if (failedTracks.length > 0) {
    const answer = prompt(
      `\n⚠️ ${failedTracks.length} tracks failed. YT Fallback? (y/n): `,
    );
    if (answer?.toLowerCase() === "y") {
      for (const t of failedTracks) {
        spawnSync(
          [
            "yt-dlp",
            "-x",
            "--audio-format",
            "m4a",
            "--add-metadata",
            "--embed-thumbnail",
            "-o",
            `${DOWNLOAD_DIR}/%(uploader)s - %(title)s [YT].%(ext)s`,
            t.url,
          ],
          { stdio: ["inherit", "inherit", "inherit"] },
        );
      }
    }
  }

  console.log("\n✨ Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("💥 Global Crash:", err);
  process.exit(1);
});
