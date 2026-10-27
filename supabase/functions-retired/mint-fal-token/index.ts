// mint-fal-token — switched off, but left in place.
//
// This route was retired when the lease model replaced the old minutes count, and it has been
// reading a column that current builds no longer use. The repository's own deploy note told us to
// delete it; it was never deleted, so it kept answering calls on the live project with no source
// file anywhere in git — which meant nothing could say what it still let through.
//
// It is disabled rather than removed, and deliberately so: a route that vanishes answers a stale
// client with a bare 404 and no reason, while a route that says "this is switched off, update the
// app" tells the customer and the panel exactly what happened. Nothing here reads or writes the
// database — no database client is imported, and no module of ours is pulled in — so this cannot
// move a minute, hand out a token, or reach a key.
//
// A copy of the artifact that was here before this stub went in is kept beside this file, in this
// folder, so putting the old behaviour back is one upload rather than a reconstruction.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  return new Response(
    JSON.stringify({
      ok: false,
      error: "retired_route",
      message: "This route is switched off. Update Stream Live to the newest version.",
    }),
    { status: 503, headers: { ...cors, "Content-Type": "application/json" } },
  );
});
