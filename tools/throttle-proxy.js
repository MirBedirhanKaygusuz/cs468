// tools/throttle-proxy.js
// Testing aid, not part of the speed test itself. It sits in front of server.js
// and behaves like a network link with a known speed, so the results of the
// speed test can be compared with the true value. It also counts the bytes it
// really forwarded, to check the data usage reported by the page.
//
// Usage:
//   node tools/throttle-proxy.js <port> <downMbps> <upMbps> <delayMs> [rampMs] [noise]
//
//   delayMs  one-way delay, so the ping should be about twice this value
//   rampMs   after being idle the link starts slow and needs this long to reach
//            full speed, which imitates TCP slow start (default 0)
//   noise    the speed changes randomly by this fraction every 200 ms, so
//            0.25 means +-25%, which imitates a busy Wi-Fi link (default 0)
//
// Example, then open http://localhost:8101 in the browser:
//   node tools/throttle-proxy.js 8101 50 10 15

const net = require("net");

const [port, downMbps, upMbps, delayMs, rampMs = 0, noise = 0] =
  process.argv.slice(2).map(Number);

const SERVER_PORT = Number(process.env.SERVER_PORT || 8080);

const PUMP_INTERVAL_MS = 2; // How often queued data is released.
const QUEUE_LIMIT = 256 * 1024; // Like the buffer of a router on the path.
const NOISE_INTERVAL_MS = 200;
const IDLE_RESET_MS = 300; // Idle for this long and the ramp starts again.
const RAMP_START = 0.1; // The ramp starts at 10% of the full speed.

// One direction of the link. Data waits in a queue and leaves at a limited rate.
class ThrottledLink {
  constructor(mbps) {
    this.bytesPerMs = (mbps * 1e6) / 8 / 1000;
    this.queue = [];
    this.queuedBytes = 0;
    this.pausedSources = new Set();
    this.forwardedBytes = 0;
    this.credit = 0; // Bytes we are allowed to send right now.
    this.lastPumpTime = performance.now();
    this.lastBusyTime = 0;
    this.rampStartTime = 0;
    this.noiseFactor = 1;

    setInterval(() => this.pump(), PUMP_INTERVAL_MS);
    setInterval(() => {
      this.noiseFactor = 1 + (Math.random() * 2 - 1) * noise;
    }, NOISE_INTERVAL_MS);
  }

  send(data, source, destination) {
    this.queue.push({ data, destination });
    this.queuedBytes += data.length;

    if (this.queuedBytes > QUEUE_LIMIT) {
      source.pause();
      this.pausedSources.add(source);
    }
  }

  // The fraction of the full speed that is available at this moment.
  currentRate(now) {
    let rate = this.noiseFactor;

    if (rampMs > 0) {
      const progress = Math.min((now - this.rampStartTime) / rampMs, 1);
      rate *= RAMP_START + (1 - RAMP_START) * progress;
    }
    return rate;
  }

  pump() {
    const now = performance.now();
    const passedMs = now - this.lastPumpTime;
    this.lastPumpTime = now;

    if (this.queue.length === 0) {
      this.credit = 0;
      return;
    }

    if (now - this.lastBusyTime > IDLE_RESET_MS) {
      this.rampStartTime = now;
    }
    this.lastBusyTime = now;

    this.credit += passedMs * this.bytesPerMs * this.currentRate(now);

    while (this.credit >= 1 && this.queue.length > 0) {
      const item = this.queue[0];

      // Data for a closed connection never goes over the link.
      if (item.destination.destroyed) {
        this.queuedBytes -= item.data.length;
        this.queue.shift();
        continue;
      }

      const length = Math.min(item.data.length, Math.floor(this.credit));
      const part = item.data.subarray(0, length);
      item.data = item.data.subarray(length);

      this.credit -= length;
      this.queuedBytes -= length;
      this.forwardedBytes += length;

      if (item.data.length === 0) {
        this.queue.shift();
      }

      setTimeout(() => {
        if (!item.destination.destroyed) {
          item.destination.write(part);
        }
      }, delayMs);
    }

    if (this.queuedBytes < QUEUE_LIMIT / 2) {
      for (const source of this.pausedSources) {
        source.resume();
      }
      this.pausedSources.clear();
    }
  }
}

const downLink = new ThrottledLink(downMbps);
const upLink = new ThrottledLink(upMbps);

const proxy = net.createServer((browserSocket) => {
  const serverSocket = net.connect(SERVER_PORT, "127.0.0.1");

  browserSocket.setNoDelay(true);
  serverSocket.setNoDelay(true);

  browserSocket.on("data", (data) => upLink.send(data, browserSocket, serverSocket));
  serverSocket.on("data", (data) => downLink.send(data, serverSocket, browserSocket));

  function closeBoth() {
    browserSocket.destroy();
    serverSocket.destroy();
  }

  for (const socket of [browserSocket, serverSocket]) {
    socket.on("close", closeBoth);
    socket.on("error", closeBoth);
  }
});

proxy.listen(port, () => {
  console.log(
    `[${port}] down ${downMbps} Mbps, up ${upMbps} Mbps, ` +
      `delay ${delayMs} ms, ramp ${rampMs} ms, noise ${noise}`
  );
});

// Print the byte counters whenever they have changed.
let lastTotal = 0;
setInterval(() => {
  const total = downLink.forwardedBytes + upLink.forwardedBytes;

  if (total !== lastTotal && downLink.queue.length === 0 && upLink.queue.length === 0) {
    lastTotal = total;
    console.log(
      `[${port}] forwarded so far: down ${(downLink.forwardedBytes / 1e6).toFixed(2)} MB, ` +
        `up ${(upLink.forwardedBytes / 1e6).toFixed(2)} MB`
    );
  }
}, 1000);
