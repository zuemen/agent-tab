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

export interface PreparedSeller {
  seller: SellerSpec;
  /** A fresh MCP server for this seller (stateless HTTP needs one per request). */
  newServer(): McpServer;
}

/**
 * One MCP server per seller; paid tools answer with an x402 PaymentRequired
 * until paid. Payment requirements are built once against the facilitator.
 */
export async function prepareSeller(seller: SellerSpec, facilitator: FacilitatorClient, network: PayPalNetwork): Promise<PreparedSeller> {
  const resourceServer = new x402ResourceServer(facilitator);
  resourceServer.register(network, new PayPalTabServerScheme());
  await resourceServer.initialize();

  const handlers: { tool: SellerSpec["tools"][number]; wrapped?: ReturnType<ReturnType<typeof createPaymentWrapper>> }[] = [];
  for (const tool of seller.tools) {
    if (!tool.price) {
      handlers.push({ tool });
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
    handlers.push({ tool, wrapped: paid(runner(seller, tool)) });
  }

  return {
    seller,
    newServer() {
      const server = new McpServer({ name: seller.id, version: "0.1.0" }, { instructions: `${seller.name}: ${seller.description} ${DEMO_NOTICE}` });
      for (const { tool, wrapped } of handlers) {
        const description = tool.price ? `${tool.description} Paid via PayPal tab.` : tool.description;
        const meta = { title: tool.title, description, inputSchema: tool.inputSchema, _meta: { price: tool.price ? `$${tool.price}` : "free", seller: seller.id } };
        server.registerTool(tool.name, meta, (wrapped ?? runner(seller, tool)) as never);
      }
      return server;
    },
  };
}

function runner(seller: SellerSpec, tool: SellerSpec["tools"][number]) {
  return async (args: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify({ seller: seller.name, notice: DEMO_NOTICE, ...(tool.run(args) as object) }) }],
  });
}

export async function createSellerServer(seller: SellerSpec, facilitator: FacilitatorClient, network: PayPalNetwork): Promise<McpServer> {
  return (await prepareSeller(seller, facilitator, network)).newServer();
}
