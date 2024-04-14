import fs from 'fs/promises';
import Irys, { WebIrys } from "@irys/sdk";
import { isBrowser, isNode } from "browser-or-node";
import { EIP1193Provider, createWalletClient, custom } from 'viem';
import { arbitrum } from 'viem/chains';

const network = 'mainnet';
const token = 'arbitrum';
const rpcUrl = 'https://arb1.arbitrum.io/rpc';

let irysInstance: Irys | WebIrys;

interface NodeProvider {
  providerUrl?: string,
  privateKeyFile?: string
}

const setWebIrys = async (provider?: EIP1193Provider) => {
  const availableProvider = provider ?? window?.ethereum;
  if (!availableProvider) {
    throw new Error('Browser Provider not available.');
  }

  const [ account ] = await availableProvider.request({ method: 'eth_requestAccounts' });

  const walletClient = createWalletClient({
    account,
    chain: arbitrum,
    transport: custom(availableProvider)
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
      providerUrl: rpcUrl ?? 'https://arb1.arbitrum.io/rpc'
    }
  });
}

export const setIrys = async (provider: NodeProvider | EIP1193Provider) => {
  if (isBrowser) {
    irysInstance = await setWebIrys(provider as EIP1193Provider);
  } else if (isNode && (provider as NodeProvider).privateKeyFile) {
    irysInstance = await setNodeIrys((provider as NodeProvider).privateKeyFile!, rpcUrl);
  } else if (isNode && !(provider as NodeProvider).privateKeyFile) {
    throw new Error('Private key file not provided');
  } else {
    throw new Error('Environment not recognized');
  }
}

export const postOnArweave = async (data: string | File, tags: { name: string, value: string }[]) => {
  try {
    if (!irysInstance) {
      throw new Error('Irys instance not Set. Please call SetIrys()');
    }
    const size = data instanceof File ? data.size : (new TextEncoder().encode(data)).length;

    // check size is below 100kb
    const kB = 1024;
    if (size > 100 * kB) {
      throw new Error('Data size too large. Must be less than 100kb');
    }
  
    if (isBrowser && data instanceof File) {
      const { id } = await (irysInstance as WebIrys).uploadFile(data, {
        tags
      });
  
      return id;
    } else if (typeof data === 'string') {
      const { id } = await irysInstance.upload(data, {
        tags
      });
  
      return id;
    } 
  } catch (e) {
    return undefined;
  }
}
