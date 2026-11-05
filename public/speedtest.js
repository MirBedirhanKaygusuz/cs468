// speedtest.js
// Runs in the browser. Measures ping, then download speed, then upload speed
// against the server this page was loaded from.
//
// The aim is an accurate result using as little time and data as possible, so
// the download and upload tests do not run for a fixed time. They keep an
// estimate of the speed and stop as soon as that estimate has settled.

// ---------- Settings ----------

const PING_COUNT = 10; // Ping requests to send, after one warm-up request.

const KB = 1024;
const MB = 1024 * KB;

// A single TCP connection often cannot fill a fast link, so several run at once.
const CONNECTIONS = 4;

// Sizes of the objects we transfer. Slow links get small objects and fast links
// get large ones. A connection is idle for one round trip between two objects,
// so an object should last about as long as the test itself. Stopping the test
// cancels whatever is still running, so a large object does not waste data.
const OBJECT_SIZES = [
  256 * KB, 512 * KB, 1 * MB, 2 * MB, 4 * MB, 8 * MB, 16 * MB, 32 * MB, 64 * MB,
];
const TARGET_REQUEST_MS = 2000; // How long one object should take to transfer.

const SAMPLE_INTERVAL_MS = 100; // How often the browser reads its byte counter.
const LIVE_WINDOW_MS = 1000; // The live speed on the page covers this much time.

// The test stops once it has run for MIN_TEST_MS and the estimate has stayed
// within STABLE_TOLERANCE for the last STABLE_TIME_MS.
const MIN_TEST_MS = 2000;
const STABLE_TIME_MS = 1000;
const STABLE_TOLERANCE = 0.05;

// Hard limits, for links that never settle or are very fast.
const MAX_TEST_MS = 8000;
const MAX_TEST_BYTES = 250e6;

// A test that has not stopped by itself after this long has lost the server.
const TEST_TIMEOUT_MS = 12000;
const REQUEST_TIMEOUT_MS = 5000; // Same, for a single small request.
const STOP_TIMEOUT_MS = 2000; // How long to wait for the final upload total.

// ---------- Page elements ----------

const startButton = document.getElementById("start-button");
const statusText = document.getElementById("status");
const progressBar = document.getElementById("progress");
const pingValue = document.getElementById("ping-value");
const downloadValue = document.getElementById("download-value");
const uploadValue = document.getElementById("upload-value");
const jitterValue = document.getElementById("jitter-value");
const downloadedValue = document.getElementById("downloaded-value");
const uploadedValue = document.getElementById("uploaded-value");
const durationValue = document.getElementById("duration-value");

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// ---------- Ping ----------

// Sends one small request and returns the round-trip time in milliseconds.
async function sendPing() {
  const url = "/ping?nocache=" + Math.random();
  const startTime = performance.now();

  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await response.text();

  const wallClockTime = performance.now() - startTime;

  // The browser records when the request really left and when the first byte
  // came back. This leaves out the time spent inside JavaScript and fetch().
  const timing = performance.getEntriesByName(response.url).pop();
  if (timing && timing.requestStart > 0 && timing.responseStart > 0) {
    return timing.responseStart - timing.requestStart;
  }
  return wallClockTime;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

async function measurePing() {
  // The first request pays for opening the connection, so it is not counted.
  await sendPing();

  const times = [];
  for (let i = 0; i < PING_COUNT; i++) {
    times.push(await sendPing());
  }

  // Jitter is the average difference between two consecutive pings.
  let differenceSum = 0;
  for (let i = 1; i < times.length; i++) {
    differenceSum += Math.abs(times[i] - times[i - 1]);
  }

  return { ping: median(times), jitter: differenceSum / (times.length - 1) };
}

// ---------- Speed calculation ----------

// Works out the speed from readings of a total byte count. All speeds are in
// megabits per second (1 Mbps = 1,000,000 bits per second).
class SpeedMeter {
  constructor() {
    this.samples = [];
  }

  // Adds one reading. Readings from before the first byte are skipped, because
  // opening connections and waiting for a response says nothing about the speed.
  addSample(time, bytes) {
    if (bytes === 0) {
      return;
    }
    const sample = { time, bytes, estimate: 0 };
    this.samples.push(sample);
    sample.estimate = this.estimate();
  }

  latestSample() {
    return this.samples[this.samples.length - 1];
  }

  elapsedMs() {
    if (this.samples.length === 0) {
      return 0;
    }
    return this.latestSample().time - this.samples[0].time;
  }

  // Average speed over the last windowMs milliseconds.
  speedOver(windowMs) {
    if (this.samples.length < 2) {
      return 0;
    }

    const latest = this.latestSample();

    let oldest = this.samples[0];
    for (const sample of this.samples) {
      if (sample.time > latest.time - windowMs) {
        break;
      }
      oldest = sample;
    }

    const seconds = (latest.time - oldest.time) / 1000;
    if (seconds === 0) {
      return 0;
    }
    return ((latest.bytes - oldest.bytes) * 8) / seconds / 1e6;
  }

  liveSpeed() {
    return this.speedOver(LIVE_WINDOW_MS);
  }

  // The result of the test: the average over the second half of the time so far.
  // Leaving out the first half removes the part where TCP is still speeding up.
  estimate() {
    return this.speedOver(this.elapsedMs() / 2);
  }

  // True when the estimate has barely changed during the last STABLE_TIME_MS.
  // On a noisy link the speed itself never settles, but this average still does.
  isStable() {
    if (this.elapsedMs() < MIN_TEST_MS) {
      return false;
    }

    const firstTime = this.latestSample().time - STABLE_TIME_MS;
    const estimates = this.samples
      .filter((sample) => sample.time >= firstTime)
      .map((sample) => sample.estimate);

    const lowest = Math.min(...estimates);
    const highest = Math.max(...estimates);

    return highest > 0 && (highest - lowest) / highest <= STABLE_TOLERANCE;
  }

  shouldStop() {
    if (this.samples.length === 0) {
      return false;
    }
    return (
      this.isStable() ||
      this.elapsedMs() >= MAX_TEST_MS ||
      this.latestSample().bytes >= MAX_TEST_BYTES
    );
  }
}

// Picks the smallest object that should last at least TARGET_REQUEST_MS, then
// moves connectionIndex sizes up the list. If all connections got the same size
// they would finish together and leave the link idle for a round trip. With
// different sizes, the other connections keep the link busy during that time.
function pickObjectSize(speedMbps, connectionIndex) {
  const bytesPerSecond = (speedMbps * 1e6) / 8 / CONNECTIONS;
  const wantedSize = (bytesPerSecond * TARGET_REQUEST_MS) / 1000;

  const lastIndex = OBJECT_SIZES.length - 1;
  let sizeIndex = OBJECT_SIZES.findIndex((size) => size >= wantedSize);
  if (sizeIndex === -1) {
    sizeIndex = lastIndex;
  }
  return OBJECT_SIZES[Math.min(sizeIndex + connectionIndex, lastIndex)];
}

// ---------- Transferring objects ----------

// Downloads one object and reports the bytes as they arrive.
async function downloadObject(size, onBytes, abortSignal) {
  const url = "/download?size=" + size + "&nocache=" + Math.random();

  const response = await fetch(url, { cache: "no-store", signal: abortSignal });
  if (!response.ok) {
    throw new Error("server replied with status " + response.status);
  }

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    onBytes(value.length);
  }
}

// Random bytes, so that nothing on the way can compress the upload.
// getRandomValues() can only fill 64 KB in one call.
function makeRandomBlock(size) {
  const block = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 64 * KB) {
    crypto.getRandomValues(block.subarray(offset, offset + 64 * KB));
  }
  return block;
}

const uploadBlock = makeRandomBlock(1 * MB);

function makeUploadBody(size) {
  const parts = [];
  for (let remaining = size; remaining > 0; remaining -= uploadBlock.length) {
    parts.push(uploadBlock.subarray(0, Math.min(remaining, uploadBlock.length)));
  }
  return new Blob(parts);
}

// Uploads one object. The server does the counting, see measureUpload().
async function uploadObject(size, testId, abortSignal) {
  const url = "/upload?test=" + testId + "&nocache=" + Math.random();

  const response = await fetch(url, {
    method: "POST",
    body: makeUploadBody(size),
    signal: abortSignal,
  });
  if (!response.ok) {
    throw new Error("server replied with status " + response.status);
  }
}

// ---------- Download and upload tests ----------

// Keeps all connections busy until the meter says to stop, then cancels them.
// transferObject(size, abortSignal) has to transfer one object.
async function runConnections(meter, transferObject) {
  const abortController = new AbortController();
  const abortSignal = abortController.signal;

  async function runConnection(connectionIndex) {
    while (!abortSignal.aborted) {
      try {
        const size = pickObjectSize(meter.liveSpeed(), connectionIndex);
        await transferObject(size, abortSignal);
      } catch (error) {
        // Stopping the test cancels the running requests, which is not an error.
        if (!abortSignal.aborted) {
          throw error;
        }
      }
    }
  }

  async function waitForMeter() {
    const startTime = performance.now();

    while (!meter.shouldStop() && !abortSignal.aborted) {
      if (performance.now() - startTime > TEST_TIMEOUT_MS) {
        throw new Error("the server stopped responding");
      }
      await sleep(SAMPLE_INTERVAL_MS);
    }
  }

  const connections = [];
  for (let i = 0; i < CONNECTIONS; i++) {
    connections.push(runConnection(i));
  }

  try {
    // The connections only end by themselves if one of them fails.
    await Promise.race([waitForMeter(), Promise.all(connections)]);
    return { speed: meter.estimate(), durationMs: meter.elapsedMs() };
  } finally {
    abortController.abort();
    await Promise.allSettled(connections);
  }
}

// In both tests the receiving side counts the bytes, because it is the only
// side that knows what really crossed the network. For a download that is the
// browser, which reads its own counter at a regular interval.
async function measureDownload(onUpdate) {
  const meter = new SpeedMeter();
  let receivedBytes = 0;

  const timer = setInterval(() => {
    meter.addSample(performance.now(), receivedBytes);
    onUpdate(meter.liveSpeed(), meter.elapsedMs());
  }, SAMPLE_INTERVAL_MS);

  function transferObject(size, abortSignal) {
    const onBytes = (count) => {
      receivedBytes += count;
    };
    return downloadObject(size, onBytes, abortSignal);
  }

  try {
    const result = await runConnections(meter, transferObject);
    return { ...result, bytes: receivedBytes };
  } finally {
    clearInterval(timer);
  }
}

// Ends an upload test on the server and returns the exact number of bytes it got.
async function fetchUploadTotal(testId) {
  const response = await fetch("/upload-stop?test=" + testId, {
    cache: "no-store",
    signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error("server replied with status " + response.status);
  }
  return Number(await response.text());
}

// For an upload the receiving side is the server, which streams its byte count
// and its clock to us while the upload is running.
async function measureUpload(onUpdate) {
  const meter = new SpeedMeter();
  const testId = String(Math.random()).slice(2);
  let reportedBytes = 0;

  const status = new EventSource("/upload-status?test=" + testId);

  status.onmessage = (event) => {
    const report = JSON.parse(event.data);
    reportedBytes = report.bytes;
    meter.addSample(report.time, report.bytes);
    onUpdate(meter.liveSpeed(), meter.elapsedMs());
  };

  function transferObject(size, abortSignal) {
    return uploadObject(size, testId, abortSignal);
  }

  try {
    // The server only counts bytes for a test once this stream is open.
    await new Promise((resolve, reject) => {
      status.onopen = resolve;
      status.onerror = () => reject(new Error("could not open the upload status stream"));
      setTimeout(() => reject(new Error("the server stopped responding")), REQUEST_TIMEOUT_MS);
    });

    const result = await runConnections(meter, transferObject);

    // On a slow link this request can get stuck behind the data still on its
    // way. The speed is already known and the stream gives a total that is
    // nearly as good, so a late answer is no reason to fail the test.
    const bytes = await fetchUploadTotal(testId).catch(() => reportedBytes);

    return { ...result, bytes };
  } finally {
    status.close();
  }
}

// ---------- Showing the results ----------

function formatSpeed(mbps) {
  if (mbps < 10) {
    return mbps.toFixed(2);
  }
  if (mbps < 100) {
    return mbps.toFixed(1);
  }
  return mbps.toFixed(0);
}

function formatBytes(bytes) {
  return (bytes / 1e6).toFixed(1) + " MB";
}

function setStatus(text, progress) {
  statusText.textContent = text;
  progressBar.value = progress;
}

function clearResults() {
  const elements = [
    pingValue, downloadValue, uploadValue,
    jitterValue, downloadedValue, uploadedValue, durationValue,
  ];
  for (const element of elements) {
    element.textContent = "-";
  }
}

// Runs the whole test. Progress goes 0-10% for ping, 10-55% for download and
// 55-100% for upload.
async function runSpeedTest() {
  startButton.disabled = true;
  clearResults();

  const testStartTime = performance.now();

  try {
    setStatus("Measuring ping...", 0);
    const { ping, jitter } = await measurePing();
    pingValue.textContent = ping.toFixed(1);
    jitterValue.textContent = jitter.toFixed(1) + " ms";

    setStatus("Measuring download speed...", 10);
    const download = await measureDownload((speed, elapsedMs) => {
      downloadValue.textContent = formatSpeed(speed);
      progressBar.value = 10 + (45 * elapsedMs) / MAX_TEST_MS;
    });
    downloadValue.textContent = formatSpeed(download.speed);
    downloadedValue.textContent = formatBytes(download.bytes);

    setStatus("Measuring upload speed...", 55);
    const upload = await measureUpload((speed, elapsedMs) => {
      uploadValue.textContent = formatSpeed(speed);
      progressBar.value = 55 + (45 * elapsedMs) / MAX_TEST_MS;
    });
    uploadValue.textContent = formatSpeed(upload.speed);
    uploadedValue.textContent = formatBytes(upload.bytes);

    const durationSeconds = (performance.now() - testStartTime) / 1000;
    durationValue.textContent = durationSeconds.toFixed(1) + " s";
    setStatus("Test finished.", 100);

    return { ping, jitter, download, upload, durationSeconds };
  } catch (error) {
    setStatus("Test failed: " + error.message, 0);
  } finally {
    startButton.disabled = false;
  }
}

startButton.addEventListener("click", runSpeedTest);
