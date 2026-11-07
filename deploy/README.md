# Deploying on AWS EC2

## Create the instance

In EC2, launch an **Ubuntu Server 24.04 LTS** instance in a region near your
users. Choose an instance whose CPU and network capacity exceed the connection
you intend to measure; a small instance is useful for setup but may bottleneck
fast connections. Check the selected instance's network limits and pricing.

Create a key pair and save its PEM file outside the repository. Select a public
subnet with a route to an internet gateway and enable auto-assigned public IPv4.
A default VPC normally provides this networking. Configure inbound security rules:

| Protocol | Port | Source |
| --- | --- | --- |
| TCP (SSH) | 22 | Your public IP /32 |
| TCP | 8080 | 0.0.0.0/0 |

Keep outbound access for Ubuntu package installation. No database, IAM role,
S3 bucket, load balancer, or AWS credentials in the application are needed.
See [AWS connection prerequisites](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connection-prereqs-general.html).

## Copy and install

From the project root on your computer (Linux, macOS, or WSL), replace the key
path and SERVER_IP with your values:

```bash
chmod 400 /path/to/key.pem
ssh -i /path/to/key.pem ubuntu@SERVER_IP 'mkdir -p ~/speedtest'
scp -i /path/to/key.pem -r server.js package.json public deploy ubuntu@SERVER_IP:~/speedtest/
ssh -i /path/to/key.pem ubuntu@SERVER_IP
```

Verify the SSH host fingerprint when connecting for the first time. Then, on EC2:

```bash
cd ~/speedtest
sudo bash deploy/install.sh
```

The installer installs Ubuntu's Node.js package, copies application files to
`/opt/speedtest`, and enables `speedtest.service`. The server runs under a dedicated
unprivileged account. Re-running the installer updates the files and restarts the
service; active tests will be interrupted. Run it from the uploaded project, not
from `/opt/speedtest`.

Open **http://SERVER_IP:8080** on your laptop. Use HTTP explicitly: this setup
does not configure TLS. Keep Node directly reachable: buffering upload requests
or the server-sent status stream in a proxy can distort the measurement.

## Check and troubleshoot

```bash
sudo systemctl status speedtest
sudo journalctl -u speedtest -n 50 --no-pager
curl -i http://127.0.0.1:8080/ping
sudo systemctl restart speedtest
```

Ping should return HTTP 204. If local curl works but the website cannot be opened,
check the public address, security group port 8080, subnet route, and any host
firewall. If UFW is enabled, allow TCP 8080 and preserve SSH access.

Reboot once and confirm the website returns without manually starting Node.
An auto-assigned public IPv4 address may change after stopping and starting EC2;
check the console again, or use an Elastic IP if a stable address is needed.

## Validate and submit

Run the test from another computer against the public address. Confirm that ping,
download, and upload appear in order, with ms, Mbps, and downloaded/uploaded MB.
Repeat several times, then compare with other speed tools on nearby servers on
the same connection. Fill the comparison table in the main README with actual
results and record the deployment URL and region. Simulated proxy results are
not a substitute for this comparison.

EC2, public IPv4, and outgoing data can incur charges. The application has no rate
limiting. Monitor usage and stop or terminate resources when finished; release
any unused Elastic IP. Budget alerts can help monitor costs but do not cap usage.

Submit the source, documentation, and tools as `lastnames_project1.zip`, excluding
Git metadata, private keys, credentials, and logs. Both teammates should understand
the implementation and be able to explain it during the demo.
