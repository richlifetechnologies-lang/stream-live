// usage-heartbeat — switched off, but left in place.
//
// This was the timer a running call ticked so its minutes kept being counted. The lease model
// replaced it: windows are now closed by lease and settled server-side, so nothing on the current
// build calls this route. It stayed live on the project with no source file in git, which meant a
// stale client could still reach a route that counted minutes the old way.
//
// Disabled rather than deleted, for the same reason as mint-fal-token: a missing route answers 404
// and tells nobody anything, while this answers and says why. There is no database client imported
// and none of our modules are pulled in, so this file cannot count, grant or take back a minute.
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
