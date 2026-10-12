import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import { createPaymentWrapper } from "@x402/mcp";
import { PayPalTabServerScheme, SCHEME, type PayPalNetwork } from "@agent-tab/x402-paypal";
import { DEMO_NOTICE, type SellerSpec } from "./catalog.ts";

export function facilitatorClientFor(url: string, sellerApiKey: string): FacilitatorClient {
  const auth = { Authorization: `Bearer ${sellerApiKey}` };
  return new HTTPFacilitatorClient({
    url,
    createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: {} }),
  });
}

/** One MCP server per seller; paid tools answer with an x402 PaymentRequired until paid. */
export async function createSellerServer(seller: SellerSpec, facilitator: FacilitatorClient, network: PayPalNetwork): Promise<McpServer> {
  const resourceServer = new x402ResourceServer(facilitator);
  resourceServer.register(network, new PayPalTabServerScheme());
  await resourceServer.initialize();

  const server = new McpServer({ name: seller.id, version: "0.1.0" }, { instructions: `${seller.name}: ${seller.description} ${DEMO_NOTICE}` });

  for (const tool of seller.tools) {
    const run = async (args: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: JSON.stringify({ seller: seller.name, notice: DEMO_NOTICE, ...(tool.run(args) as object) }) }],
    });
    const description = tool.price ? `${tool.description} Paid via PayPal tab.` : tool.description;
    if (!tool.price) {
      server.registerTool(tool.name, { title: tool.title, description, inputSchema: tool.inputSchema }, run);
      continue;
    }
    const accepts = await resourceServer.buildPaymentRequirements({
      scheme: SCHEME,
      network,
      payTo: seller.id,
      price: `$${tool.price}`,
      maxTimeoutSeconds: 120,
      extra: { resource: `${seller.id}/${tool.name}` },
    });
    const paid = createPaymentWrapper(resourceServer, {
      accepts,
      resource: { url: `mcp://tool/${tool.name}`, description: tool.description, serviceName: seller.name.slice(0, 32) },
    });
    server.registerTool(tool.name, { title: tool.title, description, inputSchema: tool.inputSchema }, paid(run) as never);
  }
  return server;
}
