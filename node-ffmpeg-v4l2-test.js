const { spawn } = require('child_process');

const W = 640;
const H = 480;
const Y_SIZE = W * H;
const UV_SIZE = (W * H) >> 2;

let frameNo = 0;
let inFlight = false;
let written = 0;
let dropped = 0;

function makeFrame(n) {
  const y = Buffer.alloc(Y_SIZE, 16);
  const u = Buffer.alloc(UV_SIZE, 128);
  const v = Buffer.alloc(UV_SIZE, 128);

  const barWidth = 80;
  const x = (n * 12) % (W + barWidth) - barWidth;
  const x0 = Math.max(0, x);
  const x1 = Math.min(W, x + barWidth);

  if (x1 > x0) {
    for (let row = 0; row < H; row++) {
      y.fill(220, row * W + x0, row * W + x1);
    }
  }

  return Buffer.concat([y, u, v]);
}

const ffmpeg = spawn('ffmpeg', [
  '-hide_banner',
  '-loglevel', 'info',
  '-stats',
  '-f', 'rawvideo',
  '-framerate', '15',
  '-pixel_format', 'yuv420p',
  '-video_size', `${W}x${H}`,
  '-i', 'pipe:0',
  '-pix_fmt', 'yuv420p',
  '-f', 'v4l2',
  '/dev/video0'
], {
  stdio: ['pipe', 'ignore', 'pipe']
});

ffmpeg.stderr.on('data', (d) => {
  process.stderr.write(d.toString());
});

ffmpeg.on('exit', (code, signal) => {
  console.log(`\nffmpeg exited: code=${code} signal=${signal}`);
  process.exit(0);
});

function tick() {
  if (inFlight) {
    dropped++;
    return;
  }

  const frame = makeFrame(frameNo++);
  inFlight = true;

  ffmpeg.stdin.write(frame, (err) => {
    inFlight = false;
    if (err) {
      console.error('WRITE_CALLBACK_ERROR:', err.message);
      process.exit(1);
    }
  });

  written++;

  if (written <= 10 || written % 30 === 0) {
    console.log(`written=${written} dropped=${dropped}`);
  }
}

const timer = setInterval(tick, 66);
tick();

process.on('SIGINT', () => {
  clearInterval(timer);
  try { ffmpeg.stdin.end(); } catch {}
  try { ffmpeg.kill('SIGTERM'); } catch {}
  setTimeout(() => process.exit(0), 1000);
});

console.log('node-ffmpeg-v4l2-test started');
