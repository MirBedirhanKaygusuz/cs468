#!/usr/bin/env bash
# Run on Ubuntu 24.04 after copying the project: sudo bash deploy/install.sh
set -euo pipefail
if [[ $EUID -ne 0 ]]; then
  echo 'Run with sudo bash deploy/install.sh' >&2
  exit 1
fi
source /etc/os-release
if [[ $ID != ubuntu || $VERSION_ID != 24.04 ]]; then
  echo 'This installer supports Ubuntu 24.04.' >&2
  exit 1
fi
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
apt-get update
apt-get install -y nodejs curl
node -e 'if (Number(process.versions.node.split(".")[0]) < 18) process.exit(1)'
if ! id speedtest >/dev/null 2>&1; then
  useradd --system --home-dir /opt/speedtest --shell /usr/sbin/nologin speedtest
fi
# Only application files are installed; private keys and Git metadata stay out.
install -d -m 755 /opt/speedtest /opt/speedtest/public
install -m 644 "$project_dir/server.js" "$project_dir/package.json" /opt/speedtest/
install -m 644 "$project_dir"/public/* /opt/speedtest/public/
install -m 644 "$project_dir/deploy/speedtest.service" /etc/systemd/system/speedtest.service
systemctl daemon-reload
systemctl enable speedtest
systemctl restart speedtest
for attempt in {1..20}; do
  if curl --fail --silent --output /dev/null http://127.0.0.1:8080/ping; then
    echo 'Speed test is running on port 8080.'
    exit 0
  fi
  sleep 1
done
journalctl -u speedtest -n 30 --no-pager
exit 1
