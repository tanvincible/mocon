# Install

**Not published to npm yet.** Today you install from the repository:

```sh
npm install github:tanvincible/mocon
npm install @opentelemetry/api
```

`@opentelemetry/api` is a peer dependency you install yourself.

## You also need somewhere for spans to go

You need an OpenTelemetry SDK and an exporter configured in your application, as for any
OpenTelemetry instrumentation.

**Without a registered tracer provider the API is a no-op and nothing is emitted, silently, with
exit code zero.** That is OpenTelemetry's behaviour rather than ours, and it is the single most
common way an integration produces nothing at all. It is not a warning you will see; it is an
absence you have to go looking for. Grep your own source for `NodeSDK` or `TracerProvider` and make
sure you find something outside a test.

If you have no trace pipeline and do not want to run one, read [No trace store](./logs.md) first.
The vocabulary is the contribution here, and it does not need a trace backend.

## The code change is the small half

If you are adopting this on a real server, read [Integrating for real](./integrating.md) before you
start. The order you do things in decides whether the day you merge is an improvement or a
regression, and four trials paid for that lesson.
