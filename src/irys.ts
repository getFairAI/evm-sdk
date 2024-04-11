import fs from 'fs/promises';
import Irys, { WebIrys } from "@irys/sdk";
import { isBrowser, isNode } from "browser-or-node";
import { createWalletClient, custom } from 'viem';
import { arbitrumSepolia } from 'viem/chains';

const network = 'devnet';
const token = 'arbitrum';
const rpcUrl = 'https://sepolia-rollup.arbitrum.io/rpc';

let irysInstance: Irys | WebIrys;

const setWebIrys = async () => {
  if (!window?.ethereum) {
    throw new Error('Browser Provider not available.');
  }

  const [ account ] = await window.ethereum.request({ method: 'eth_requestAccounts' });

  const walletClient = createWalletClient({
    account,
    chain: arbitrumSepolia,
    transport: custom(window.ethereum)
  });
	// Create a wallet object
	const wallet = { name: "viemv2", rpcUrl, provider: walletClient };
	// Use the wallet object
	const webIrys = new WebIrys({ network, token, wallet });
	await webIrys.ready();
 
	return webIrys;
}

const setNodeIrys = async (privateKeyFile: string, rpcUrl?: string) => {
  const privateKey = await fs.readFile(privateKeyFile, 'utf-8');
  
  return new Irys({
    token,
    network,
    key: privateKey,
    config: {
      providerUrl: rpcUrl || 'https://sepolia-rollup.arbitrum.io/rpc'
    }
  });
}

export const setIrys = async (privateKeyFile?: string, rpcUrl?: string) => {
  if (isBrowser) {
    irysInstance = await setWebIrys();
  } else if (isNode && privateKeyFile) {
    irysInstance = await setNodeIrys(privateKeyFile, rpcUrl);
  } else if (isNode && !privateKeyFile) {
    throw new Error('Private key file not provided');
  } else {
    throw new Error('Environment not recognized');
  }
}

export const postOnArweave = async (data: string, tags: { name: string, value: string }[]) => {
  try {
    console.log(isBrowser);
    if (!irysInstance) {
      throw new Error('Irys instance not Set. Please call SetIrys()');
    }
    const size = (new TextEncoder().encode(data)).length;

    // check size is below 100kb
    const kB = 1024;
    if (size > 100 * kB) {
      throw new Error('Data size too large. Must be less than 100kb');
    }
  
    /* const price = await irysInstance.getPrice(size);
    await irysInstance.fund(price); */
  
    const { id } = await irysInstance.upload(data, {
      tags
    });
    console.log(`${data} --> Uploaded to https://gateway.irys.xyz/${id}`);

    return id;
  } catch (e) {
    console.log("Error uploading", e);
  }
}
