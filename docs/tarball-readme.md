# herdr-web Desktop Bundle

This bundle contains the `herdr-web` browser UI assets and the `herdr-web-bridge` executable.

It does not include Herdr itself. Start or attach a Herdr session separately before running this
bundle.

## Run

From the unpacked bundle directory:

```bash
bin/herdr-web
```

Open:

```text
http://127.0.0.1:8787
```

## LAN And Android

To expose the bridge to another device on a trusted local network:

```bash
bin/herdr-web --host 0.0.0.0 --port 4000 --allow-origin http://localhost
```

If Android connects through a DNS hostname, allow that hostname too:

```bash
bin/herdr-web --host 0.0.0.0 --port 4000 \
  --allow-origin http://localhost \
  --allow-host herdr-host.local
```

Then add the bridge URL in the Android app's Bridges settings.

Only bind to non-loopback interfaces on networks you trust.
