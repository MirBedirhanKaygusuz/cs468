// server.js
// HTTP server for the speed test. It only uses modules built into Node.js.
//
//   GET  /           the web page (and its CSS and JavaScript files)
//   GET  /ping       empty response, used to measure round-trip time
//   GET  /download   sends ?size=N bytes of random data
//   POST /upload     reads the request body, throws it away, replies with the byte count
//   GET  /upload-status   streams how many bytes an upload test has delivered so far
//   GET  /upload-stop     ends an upload test and replies with its final byte count

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;

const BLOCK_SIZE = 1024 * 1024; // Data is written to the socket in blocks of 1 MiB.
const MAX_OBJECT_SIZE = 64 * 1024 * 1024; // Largest allowed download or upload (64 MiB).
const STATUS_INTERVAL_MS = 100; // How often a running upload test gets a report.

// The "objects" are not real files. Any size can be served from this one block
// of random bytes. Random data matters because it cannot be compressed by
// anything between the server and the browser, which would inflate the result.
const randomBlock = crypto.randomBytes(BLOCK_SIZE);

// A cached response would measure the disk of the browser instead of the network.
const NO_CACHE_HEADERS = { "Cache-Control": "no-store" };

// The upload tests that are running, by test id. Each one has the bytes received
// so far and the upload requests that are still in progress.
const uploadTests = new Map();

// Only these files can be requested, so paths like /../server.js cannot work.
const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/speedtest.js": { file: "speedtest.js", type: "text/javascript; charset=utf-8" },
};

function sendText(response, status, text) {
  response.writeHead(status, { "Content-Type": "text/plain", ...NO_CACHE_HEADERS });
  response.end(text);
}

function handlePing(response) {
  response.writeHead(204, NO_CACHE_HEADERS);
  response.end();
}

function handleDownload(response, url) {
  const size = Number(url.searchParams.get("size"));

  if (!Number.isInteger(size) || size <= 0 || size > MAX_OBJECT_SIZE) {
    sendText(response, 400, "size must be between 1 and " + MAX_OBJECT_SIZE);
    return;
  }

  response.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": size,
    ...NO_CACHE_HEADERS,
  });

  let remaining = size;

  // Write until the socket buffer is full, then wait for the "drain" event.
  // Without this wait, the whole object would pile up in memory.
  // If the browser cancels the request, "drain" never fires and writing stops.
  function writeMore() {
    while (remaining > 0) {
      const length = Math.min(remaining, BLOCK_SIZE);
      remaining -= length;

      if (!response.write(randomBlock.subarray(0, length))) {
        response.once("drain", writeMore);
        return;
      }
    }
    response.end();
  }

  writeMore();
}

function handleUpload(request, response, url) {
  const test = uploadTests.get(url.searchParams.get("test"));
  let received = 0;

  if (test) {
    test.requests.add(request);
    request.on("close", () => test.requests.delete(request));
  }

  request.on("data", (chunk) => {
    received += chunk.length;

    if (test) {
      test.bytes += chunk.length;
    }

    if (received > MAX_OBJECT_SIZE) {
      request.destroy();
    }
  });

  request.on("end", () => {
    sendText(response, 200, String(received));
  });
}

// Upload speed has to be measured here, at the receiving end. The browser can
// only see how much it handed to the operating system, and the operating system
// accepts data long before it has crossed the network. So the server sends the
// browser its byte count and clock regularly, using server-sent events.
function handleUploadStatus(response, url) {
  const testId = url.searchParams.get("test");
  const test = { bytes: 0, requests: new Set() };
  uploadTests.set(testId, test);

  response.writeHead(200, { "Content-Type": "text/event-stream", ...NO_CACHE_HEADERS });

  function sendReport() {
    const report = { time: performance.now(), bytes: test.bytes };
    response.write("data: " + JSON.stringify(report) + "\n\n");
  }

  sendReport();
  const timer = setInterval(sendReport, STATUS_INTERVAL_MS);

  response.on("close", () => {
    clearInterval(timer);
    closeUploads(test);
    uploadTests.delete(testId);
  });
}

// Closing the sockets from this side matters. If the browser just cancels its
// requests, its operating system still sends all the data it has buffered,
// which wastes data. Closing them here makes it throw that data away.
function closeUploads(test) {
  for (const request of test.requests) {
    request.destroy();
  }
}

function handleUploadStop(response, url) {
  const test = uploadTests.get(url.searchParams.get("test"));

  if (!test) {
    sendText(response, 404, "No such test");
    return;
  }

  closeUploads(test);
  sendText(response, 200, String(test.bytes));
}

function handleStaticFile(response, staticFile) {
  const filePath = path.join(__dirname, "public", staticFile.file);

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendText(response, 500, "Could not read " + staticFile.file);
      return;
    }
    response.writeHead(200, { "Content-Type": staticFile.type });
    response.end(content);
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");

  if (request.method === "GET" && url.pathname === "/ping") {
    handlePing(response);
  } else if (request.method === "GET" && url.pathname === "/download") {
    handleDownload(response, url);
  } else if (request.method === "POST" && url.pathname === "/upload") {
    handleUpload(request, response, url);
  } else if (request.method === "GET" && url.pathname === "/upload-status") {
    handleUploadStatus(response, url);
  } else if (request.method === "GET" && url.pathname === "/upload-stop") {
    handleUploadStop(response, url);
  } else if (request.method === "GET" && STATIC_FILES[url.pathname]) {
    handleStaticFile(response, STATIC_FILES[url.pathname]);
  } else {
    sendText(response, 404, "Not found");
  }
});

server.listen(PORT, () => {
  console.log("Speed test server running at http://localhost:" + PORT);
});
