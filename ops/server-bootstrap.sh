#!/usr/bin/env bash
# arc-20 server bootstrap — arc20.tech (idempotent, no impact on other projects)
# - code -> /opt/arc20 (standalone dir)
# - standalone Node runtime -> /opt/arc20/node (system node untouched)
# - indexer on 127.0.0.1:18820 (empty-wait mode until contracts deployed)
# - systemd: arc20-indexer (enabled) / arc20-oracle (installed, not enabled — needs oracle key)
# - Caddy: arc20.tech site block (auto-TLS), other sites untouched
set -euo pipefail
ARC=/opt/arc20
PORT=18820

echo "== 1. code =="
mkdir -p "$ARC"
tar -xzf /tmp/arc20-deploy.tar.gz -C "$ARC"
rm -rf "$ARC/launchpad" "$ARC/demo" "$ARC/lib"   # submodules/scratch, not needed on server
ls "$ARC"

echo "== 2. standalone Node runtime =="
if [ ! -x "$ARC/node/bin/node" ]; then
  ok=""
  for V in v22.22.1 v22.14.0 v22.13.1; do
    if curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz"; then ok="$V"; break; fi
  done
  [ -n "$ok" ] || { echo "node download failed"; exit 1; }
  mkdir -p "$ARC/node"
  tar -xJf /tmp/node.tar.xz -C "$ARC/node" --strip-components=1
fi
"$ARC/node/bin/node" -v

echo "== 3. production config (empty-wait mode) =="
HEAD_HEX=$(curl -fsS -X POST https://rpc.mainnet.arc.io -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}')
HEAD=$(printf '%s' "$HEAD_HEX" | "$ARC/node/bin/node" -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(parseInt(JSON.parse(d).result,16)))')
echo "arc mainnet head: $HEAD"
cat > "$ARC/indexer/config.production.json" <<EOF
{
  "_comment": "arc20.tech production config. EMPTY-WAIT MODE: hub/market are zero until contracts are deployed; after deploy set hubAddress/marketAddress/deployBlock (deploy tx block) and restart arc20-indexer.",
  "rpcUrl": "https://rpc.mainnet.arc.io",
  "chainId": 5042,
  "explorerApi": "https://explorer.arc.io/api",
  "hubAddress": "0x0000000000000000000000000000000000000000",
  "marketAddress": "0x0000000000000000000000000000000000000000",
  "deployBlock": $HEAD,
  "confirmations": 10,
  "batchBlocks": 200,
  "pollMs": 3000,
  "port": $PORT,
  "stateFile": "/opt/arc20/indexer/state.json",
  "eventsFile": "/opt/arc20/indexer/events.jsonl"
}
EOF
rm -f "$ARC/indexer/state.json" "$ARC/indexer/events.jsonl"

echo "== 4. systemd units =="
cat > /etc/systemd/system/arc20-indexer.service <<EOF
# arc-20 indexer (accounting authority) — arc20.tech
[Unit]
Description=arc-20 inscription indexer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/arc20
Environment=CONFIG_PATH=/opt/arc20/indexer/config.production.json
ExecStart=/opt/arc20/node/bin/node /opt/arc20/indexer/indexer.mjs
Restart=always
RestartSec=3
StartLimitIntervalSec=60
StartLimitBurst=10
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/arc20/indexer
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/arc20-oracle.service <<EOF
# arc-20 market oracle — NOT enabled: needs /etc/arc20/oracle.env (ORACLE_PRIVATE_KEY)
[Unit]
Description=arc-20 market oracle
After=network-online.target arc20-indexer.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/arc20
Environment=CONFIG_PATH=/opt/arc20/indexer/config.production.json
Environment=API_URL=http://127.0.0.1:$PORT
# cast must live at /usr/local/bin/cast (installed in step 5): /root/.foundry/bin
# is invisible to this unit because ProtectHome=true hides /root — a PATH entry
# pointing there silently yields spawnSync cast ENOENT/EACCES on every confirm.
Environment=CAST_BIN=/usr/local/bin/cast
EnvironmentFile=-/etc/arc20/oracle.env
ExecStart=/opt/arc20/node/bin/node /opt/arc20/indexer/oracle.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
mkdir -p /etc/arc20
systemctl daemon-reload
systemctl enable --now arc20-indexer
sleep 2
systemctl is-active arc20-indexer

echo "== 5. foundry (cast, needed by oracle later) =="
if [ ! -x /root/.foundry/bin/cast ]; then
  curl -L https://foundry.paradigm.xyz | bash || echo FOUNDRY_INSTALLER_FAILED
  /root/.foundry/bin/foundryup || echo FOUNDRYUP_FAILED
fi
/root/.foundry/bin/cast --version 2>/dev/null || echo "cast not ready (finish later)"
# Copy (not symlink — ProtectHome hides /root) cast where the oracle unit can exec it.
if [ -x /root/.foundry/bin/cast ]; then
  install -m 0755 /root/.foundry/bin/cast /usr/local/bin/cast
  /usr/local/bin/cast --version
fi

echo "== 6. Caddy site arc20.tech =="
cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)"
if ! grep -q '^arc20.tech' /etc/caddy/Caddyfile; then
cat >> /etc/caddy/Caddyfile <<EOF

arc20.tech {
	encode zstd gzip
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		X-Frame-Options SAMEORIGIN
	}
	request_body {
		max_size 12MB
	}
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
EOF
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy

echo "== 7. self-check =="
sleep 1
curl -s "http://127.0.0.1:$PORT/api/status" | head -c 300; echo
curl -s -o /dev/null -w 'local443: %{http_code}\n' --resolve arc20.tech:443:127.0.0.1 https://arc20.tech/api/status || true
echo BOOTSTRAP_DONE
