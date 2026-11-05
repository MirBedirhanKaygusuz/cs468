# Speed Test

A website that measures the ping, download speed and upload speed between the
browser and the server. It also reports how much data the test used.

The speed testing itself is written from scratch. The server only uses modules
built into Node.js and the page is plain JavaScript, so there are no libraries.

## Requirements

- Node.js 18 or newer (developed with Node.js 24). Nothing needs to be installed
  with npm, and there is no build step.
- A current web browser. So far it has only been tested on Chromium 152.

## Running it locally

```bash
node server.js
```

Then open <http://localhost:8080> and press Start. To use another port:

```bash
PORT=3000 node server.js
```

A local run only shows that everything works. There is no real network between
the browser and the server, so it reports several Gbps. Use a cloud server, or
the throttling proxy described below, to get meaningful numbers.

## Deploying to a cloud server

Use an Ubuntu 24.04 EC2 instance with a public IPv4 address. Follow
[the AWS deployment guide](deploy/README.md) to configure networking, copy the
project, and install a systemd service that starts at boot and restarts on failure.
There is no npm install or build step. The application listens directly on 8080.

Two things to watch out for:

- **Use a plain virtual machine, with Node.js directly reachable.** The upload
  test needs to see data as it arrives. A reverse proxy that buffers request
  bodies (nginx does by default, and so do many hosting platforms) hides that
  from the server and makes the upload result wrong.
- **Check the limits of the machine.** Small instances can have limited network
  speed, which would show up as a low result. Outgoing data is also billed, and
  one test on a 100 Mbps connection uses about 33 MB.

## How it works

### Ping

The browser sends 11 small requests one after another. The first one is ignored
because it pays for opening the connection. The ping is the median of the other
10, so one slow request does not change the result. The time comes from the
browser's Resource Timing data (`responseStart - requestStart`), which leaves out
the time spent inside JavaScript. Jitter is the average difference between two
consecutive pings.

### Download and upload

Each test runs 4 connections in parallel, because one TCP connection often cannot
fill a fast link. The server generates objects of any size from a block of random
bytes. The data has to be random so that nothing on the way can compress it.

**Object sizes** go from 256 KB to 64 MB and are picked from the measured speed, so
that an object lasts at least 2 seconds. Each connection also uses a different
size. A connection is idle for one round trip between two objects, and if all of
them finished together the link would be empty during that time and the result
would be too low. Large objects do not waste data, since stopping the test cancels
them.

**The receiving side counts the bytes.** For a download that is the browser. For
an upload it has to be the server, because the browser can only see what it has
given to the operating system, which accepts data long before it has crossed the
network. Relying on the browser's upload progress gave results as wrong as 0 Mbps
on a 2 Mbps link. So the server sends its byte count and clock to the browser ten
times a second, using server-sent events.

**The result** is the average speed over the second half of the test. The first
half is left out because TCP is still speeding up there. The clock starts at the
first byte, so the time spent opening connections is not counted.

**The test stops early** to save time and data. It stops once it has run for at
least 2 seconds and the result has stayed within 5% for the last second. Otherwise
it stops after 8 seconds or 250 MB. On a stable link this means about 2 seconds
for each direction.

### Data used

The page shows the data downloaded and uploaded in decimal megabytes. When an
upload stops, the browser asks the server for its exact total and the server closes
the upload connections. This also makes the browser's operating system throw away
the data it had buffered, instead of sending it for nothing.

These numbers count the content of the objects. HTTP headers and TCP/IP overhead
are not included and add a few percent. The data still on its way at the moment
the test stops is not included either.

All speeds are in megabits per second (1 Mbps = 1,000,000 bits per second).

## Accuracy tests

`tools/throttle-proxy.js` sits in front of the server and behaves like a link with
a known speed and delay, so the results can be compared with the true value. It
can also imitate TCP speeding up (ramp) and a noisy link, and it counts the bytes
it really forwarded. To try it, run the server and in a second terminal:

```bash
node tools/throttle-proxy.js 8101 50 10 15
```

Then open <http://localhost:8101>. This is a 50 Mbps down, 10 Mbps up link with
15 ms of delay in each direction. The usage is explained at the top of the file.

One run on each link, in Chromium, gave these results. "Reference ping" was
measured outside the browser with a raw socket. "Sent" is what the proxy forwarded.

| Link (down / up, delay each way) | Ping (reference) | Download | Upload | Reported down / up | Sent down / up | Total time |
| --- | --- | --- | --- | --- | --- | --- |
| 1 / 0.5 Mbps, 20 ms | 51.4 ms (45.3) | 1.00 | 0.50 | 0.27 / 0.25 MB | 0.31 / 0.80 MB | 7.0 s |
| 10 / 2 Mbps, 40 ms | 86.0 ms (85.0) | 10.00 | 1.98 | 2.57 / 0.85 MB | 2.66 / 0.88 MB | 6.7 s |
| 50 / 10 Mbps, 15 ms | 33.9 ms (35.0) | 50.06 | 10.00 | 13.05 / 2.98 MB | 13.21 / 3.02 MB | 5.0 s |
| 100 / 20 Mbps, 10 ms | 24.8 ms (24.9) | 99.88 | 19.98 | 27.53 / 5.72 MB | 27.77 / 5.77 MB | 4.9 s |
| 500 / 100 Mbps, 5 ms | 13.4 ms (14.5) | 501.00 | 99.90 | 137.89 / 27.92 MB | 138.52 / 28.05 MB | 4.7 s |
| 100 / 20 Mbps, 150 ms | 303.9 ms (305.5) | 100.07 | 19.99 | 25.23 / 6.34 MB | 27.21 / 6.74 MB | 9.0 s |
| 100 / 20 Mbps, 10 ms, 1 s ramp | 23.7 ms | 100.04 | 19.97 | 24.88 / 5.54 MB | 25.07 / 5.59 MB | 5.1 s |
| 100 / 20 Mbps, 10 ms, 2 s ramp | 24.1 ms | 100.23 | 19.98 | 32.57 / 7.84 MB | 32.79 / 7.91 MB | 7.5 s |
| 100 / 20 Mbps, 10 ms, noise +-25% | 23.8 ms | 102.20 | 20.47 | 51.29 / 6.91 MB | 51.48 / 6.97 MB | 7.2 s |
| 100 / 20 Mbps, 10 ms, noise +-50% | 24.9 ms | 74.98 | 20.51 | 29.68 / 12.70 MB | 29.95 / 12.75 MB | 8.2 s |

The last row is the worst result that was seen. A noisy link is not a fixed speed,
so a short test measures what the link happened to deliver at that moment. Over
repeated runs with +-25% noise the download was between 93 and 102 Mbps, and with
+-50% noise it was usually between 85 and 105 Mbps.

A stricter stopping rule based on the standard error was also tried. It took about
twice as long on noisy links without being more accurate, so it was removed.

## Comparison with other speed tests

Fill this in from the deployed server. Run the tests one after another, on the same
connection, with nothing else using it.

| Tool | Server location | Ping (ms) | Download (Mbps) | Upload (Mbps) | Data used |
| --- | --- | --- | --- | --- | --- |
| This project | | | | | |
| speedtest.net | | | | | |
| fast.com | | | | | |
| hiztesti.com.tr | | | | | |

## Limitations

- The tests above use a simulated link. It imitates speed, delay, ramp and noise,
  but not packet loss or real TCP congestion control. A real network can behave
  differently, which is why the comparison above is needed.
- On a very slow uplink (below about 1 Mbps) the reported upload can be much lower
  than what was really sent, because the stop request is stuck behind the data on
  its way. The speed is not affected. Slow uplinks can also add up to 2 seconds
  to the test while waiting for that request.
- Reported data is a little lower than the real amount on links with a long delay,
  because more data is on its way when the test stops (about 7% at 300 ms).
- There is no rate limiting, so anyone who has the URL can use the server's
  bandwidth. Objects are limited to 64 MiB each.

## Files

| File | Purpose |
| --- | --- |
| `server.js` | HTTP server: page, ping, download, upload |
| `public/index.html` | The web page |
| `public/style.css` | Styling of the page |
| `public/speedtest.js` | The tests, the speed calculation and the display of results |
| `tools/throttle-proxy.js` | Simulated network link, only used for accuracy tests |
