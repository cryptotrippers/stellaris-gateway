import { createFileRoute } from "@tanstack/react-router";

const BODY = `# RFC 9116 security.txt for stellaris.finance
# See SECURITY.md for full policy and safe-harbor language.

Contact: mailto:security@stellaris.finance
Expires: 2027-01-01T00:00:00.000Z
Preferred-Languages: en
Policy: https://stellaris-gateway.lovable.app/security
Canonical: https://stellaris-gateway.lovable.app/.well-known/security.txt
`;

export const Route = createFileRoute("/.well-known/security.txt")({
  server: {
    handlers: {
      GET: async () =>
        new Response(BODY, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        }),
    },
  },
});
