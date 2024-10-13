import { config as dotenv } from "dotenv";
import {
  createWalletClient,
  http,
  getContract,
  erc20Abi,
  parseUnits,
  maxUint256,
  publicActions,
  concat,
  numberToHex,
  size,
} from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { scroll } from "viem/chains";
import { wethAbi } from "./abi/weth-abi";

// Load environment variables
dotenv();
const { PRIVATE_KEY, ZERO_EX_API_KEY, ALCHEMY_HTTP_TRANSPORT_URL } = process.env;

// Validate environment variables
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY.");
if (!ZERO_EX_API_KEY) throw new Error("Missing ZERO_EX_API_KEY.");
if (!ALCHEMY_HTTP_TRANSPORT_URL) throw new Error("Missing ALCHEMY_HTTP_TRANSPORT_URL.");

// Setup headers
const headers = new Headers({
  "Content-Type": "application/json",
  "0x-api-key": ZERO_EX_API_KEY,
  "0x-version": "v2",
});

// Setup wallet client
const client = createWalletClient({
  account: privateKeyToAccount(`0x${PRIVATE_KEY}` as `0x${string}`),
  chain: scroll,
  transport: http(ALCHEMY_HTTP_TRANSPORT_URL),
}).extend(publicActions); // Extend wallet client with publicActions for public client

const [address] = await client.getAddresses();

// Setup contracts
const weth = getContract({
  address: "0x5300000000000000000000000000000000000004",
  abi: wethAbi,
  client,
});
const wsteth = getContract({
  address: "0xf610A9dfB7C89644979b4A0f27063E9e7d7Cda32",
  abi: erc20Abi,
  client,
});

// Function to display liquidity sources
const displayLiquiditySources = (route: any) => {
  const fills = route.fills || [];
  if (fills.length > 0) {
    console.log(`${fills.length} Sources`);
    fills.forEach((fill: any) => {
      const percentage = (parseInt(fill.proportionBps) / 100).toFixed(2);
      console.log(`${fill.source}: ${percentage}%`);
    });
  } else {
    console.log("No liquidity sources found.");
  }
};

// Function to display buy/sell taxes
const displayTokenTaxes = (tokenMetadata: any) => {
  const buyTax = parseInt(tokenMetadata.buyToken.buyTaxBps || 0) / 100;
  const sellTax = parseInt(tokenMetadata.buyToken.sellTaxBps || 0) / 100;

  if (buyTax > 0) {
    console.log(`Buy Token Buy Tax: ${buyTax.toFixed(2)}%`);
  }
  if (sellTax > 0) {
    console.log(`Buy Token Sell Tax: ${sellTax.toFixed(2)}%`);
  }
};

// Function to get liquidity sources on Scroll
const getLiquiditySources = async () => {
  try {
    const response = await fetch("https://api.0x.org/swap/v1/sources", { headers });
    const data = await response.json();
    const sources = data.sources.map((source: any) => source.name);
    console.log("Liquidity sources for Scroll chain:", sources.join(", "));
  } catch (error) {
    console.error("Error fetching liquidity sources:", error);
  }
};

const main = async () => {
  // Display all liquidity sources on Scroll
  await getLiquiditySources();

  // Specify sell amount
  const decimals = (await weth.read.decimals()) as number;
  const sellAmount = parseUnits("0.1", decimals);

  // Add parameters for affiliate fees and surplus collection
  const affiliateFeeBps = "100"; // 1%
  const surplusCollection = "true";

  // Fetch price with monetization parameters
  const priceParams = new URLSearchParams({
    chainId: client.chain.id.toString(),
    sellToken: weth.address,
    buyToken: wsteth.address,
    sellAmount: sellAmount.toString(),
    taker: client.account.address,
    affiliateFee: affiliateFeeBps, // Parameter for affiliate fees
    surplusCollection: surplusCollection, // Parameter for surplus collection
  });

  try {
    const priceResponse = await fetch(
      "https://api.0x.org/swap/permit2/price?" + priceParams.toString(),
      { headers }
    );
    const price = await priceResponse.json();
    console.log("Fetching price to swap 0.1 WETH for wstETH");
    console.log("priceResponse: ", price);

    // Check if taker needs to set an allowance for Permit2
    if (price.issues?.allowance) {
      const { request } = await weth.simulate.approve([
        price.issues.allowance.spender,
        maxUint256,
      ]);
      const hash = await weth.write.approve(request.args);
      console.log("Approved Permit2 to spend WETH.", await client.waitForTransactionReceipt({ hash }));
    } else {
      console.log("WETH already approved for Permit2");
    }

    // Fetch quote with monetization parameters
    const quoteParams = new URLSearchParams(priceParams);
    const quoteResponse = await fetch(
      "https://api.0x.org/swap/permit2/quote?" + quoteParams.toString(),
      { headers }
    );
    const quote = await quoteResponse.json();
    console.log("quoteResponse: ", quote);

    // Display liquidity sources breakdown
    if (quote.route) {
      displayLiquiditySources(quote.route);
    }

    // Display buy/sell taxes for tokens
    if (quote.tokenMetadata) {
      displayTokenTaxes(quote.tokenMetadata);
    }

    // Display affiliate fees and surplus
    if (quote.affiliateFeeBps) {
      const affiliateFee = (parseInt(quote.affiliateFeeBps) / 100).toFixed(2);
      console.log(`Affiliate Fee: ${affiliateFee}%`);
    }
    if (quote.tradeSurplus && parseFloat(quote.tradeSurplus) > 0) {
      console.log(`Trade Surplus Collected: ${quote.tradeSurplus}`);
    }

    // Sign permit2 transaction and submit
    if (quote.permit2?.eip712) {
      const signature = await client.signTypedData(quote.permit2.eip712);
      if (signature && quote.transaction.data) {
        const signatureLengthInHex = numberToHex(size(signature), { signed: false, size: 32 });
        const transactionData = concat([quote.transaction.data as Hex, signatureLengthInHex as Hex, signature as Hex]);
        const nonce = await client.getTransactionCount({ address: client.account.address });
        const signedTransaction = await client.signTransaction({
          account: client.account,
          chain: client.chain,
          gas: BigInt(quote?.transaction?.gas || 0),
          to: quote?.transaction?.to,
          data: transactionData,
          value: BigInt(quote?.transaction?.value || 0),
          gasPrice: BigInt(quote?.transaction?.gasPrice || 0),
          nonce: nonce,
        });
        const txHash = await client.sendRawTransaction({ serializedTransaction: signedTransaction });
        console.log("Transaction hash:", txHash);
        console.log(`See tx details at https://scrollscan.com/tx/${txHash}`);
      }
    }
  } catch (error) {
    console.error("Error during the swap process:", error);
  }
};

main();
