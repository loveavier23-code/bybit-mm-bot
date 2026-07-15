/**
 * Bybit API Proxy — Supabase Edge Function (Singapore)
 *
 * Solves the Bybit geo-block: Vercel runs in US (geo-blocked by Bybit's CloudFront),
 * but this Supabase Edge Function runs in Singapore (ap-southeast-1) which is NOT blocked.
 *
 * Usage:
 *   POST https://gcwwubldqdeoabrfwyoy.supabase.co/functions/v1/bybit-proxy
 *   Body: { method, path, params, body, apiKey, apiSecret }
 */

const BYBIT_BASE = "https://api-demo.bybit.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// HMAC-SHA256 using Web Crypto API (available in Deno)
async function hmacSha256(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw", encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { method, path, params = {}, body = {}, apiKey, apiSecret } = await req.json();

    if (!path) {
      return new Response(JSON.stringify({ error: "path required" }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Build URL
    const url = new URL(`${BYBIT_BASE}${path}`);
    let paramStr: string;
    if (method === "GET") {
      Object.entries(params).forEach(([k, v]: [string, any]) => url.searchParams.set(k, String(v)));
      paramStr = url.search.slice(1);
    } else {
      paramStr = JSON.stringify(body);
    }

    // Sign request
    const timestamp = Date.now().toString();
    const recvWindow = "10000";
    const payload = `${timestamp}${apiKey}${recvWindow}${paramStr}`;
    const signature = await hmacSha256(apiSecret, payload);

    const headers: Record<string, string> = {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": signature,
      "X-BAPI-SIGN-TYPE": "2",
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
    }

    // Forward to Bybit
    const bybitRes = await fetch(url.toString(), {
      method,
      headers,
      body: method === "POST" ? paramStr : undefined,
    });

    const text = await bybitRes.text();
    const contentType = bybitRes.headers.get("Content-Type") || "application/json";

    return new Response(text, {
      status: bybitRes.status,
      headers: { "Content-Type": contentType, ...corsHeaders },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
