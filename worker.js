function errorResponse(message, status) {
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== "/api" && !requestUrl.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (!env.API_ORIGIN) {
      return errorResponse("The API_ORIGIN Worker variable is not configured.", 503);
    }

    let apiOrigin;
    try {
      apiOrigin = new URL(env.API_ORIGIN);
    } catch {
      return errorResponse("The API_ORIGIN Worker variable must be a valid HTTPS origin.", 500);
    }

    if (
      apiOrigin.protocol !== "https:"
      || apiOrigin.username
      || apiOrigin.password
      || apiOrigin.pathname !== "/"
      || apiOrigin.search
      || apiOrigin.hash
    ) {
      return errorResponse("The API_ORIGIN Worker variable must be an HTTPS origin without a path.", 500);
    }

    const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, apiOrigin);
    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Host", requestUrl.host);
    headers.set("X-Forwarded-Proto", "https");

    const requestInit = {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    };
    if (requestInit.body) {
      requestInit.duplex = "half";
    }

    const upstreamResponse = await fetch(upstreamUrl, requestInit);
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set("Cache-Control", "no-store");

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  },
};
