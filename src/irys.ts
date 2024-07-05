import fs from 'fs/promises';
import Irys, { WebIrys } from "@irys/sdk";
import { isBrowser, isNode } from "browser-or-node";
import { EIP1193Provider, createWalletClient, custom } from 'viem';
import { arbitrum } from 'viem/chains';
import { ArweaveSigner } from 'arbundles';
import { type JWKInterface } from 'arweave/web/lib/wallet';

const network = 'mainnet';
const token = 'arbitrum';
const rpcUrl = 'https://arb1.arbitrum.io/rpc';

let irysInstance: Irys | WebIrys;
let throwawayInstance: WebIrys;

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
  
  const irys = new Irys({
    token,
    network,
    key: privateKey,
    config: {
      providerUrl: rpcUrl ?? 'https://arb1.arbitrum.io/rpc'
    }
  });

  await irys.ready();

  return irys;
}

export const setIrys = async (provider: NodeProvider | EIP1193Provider | JWKInterface) => {
  if (provider && typeof provider === 'object' && 'kty' in provider) {
    const arweaveSigner = new ArweaveSigner(provider as JWKInterface);
    (arweaveSigner as ArweaveSigner & { getActivePublicKey: () => Promise<string>}).getActivePublicKey = async () => {
      return provider.n;
    };
    // arweaveSigner.getActivePublicKey = arweaveSigner.signer

    throwawayInstance = new WebIrys({
      token: 'arweave',
      wallet: {
        provider: arweaveSigner,
      },
      network,
    });
    await throwawayInstance.ready();
  } else if (isBrowser) {
    irysInstance = await setWebIrys(provider as EIP1193Provider);
  } else if (isNode && (provider as NodeProvider).privateKeyFile) {
    irysInstance = await setNodeIrys((provider as NodeProvider).privateKeyFile!, rpcUrl);
  } else if (isNode && !(provider as NodeProvider).privateKeyFile) {
    throw new Error('Private key file not provided');
  } else {
    throw new Error('Environment not recognized');
  }
}

export const postOnArweave = async (data: string | File, tags: { name: string, value: string }[], useThrowaway = false) => {
  try {
    if (!useThrowaway && !irysInstance) {
      throw new Error('Irys instance not Set. Please call SetIrys()');
    } else if (useThrowaway && !throwawayInstance) {
      throw new Error('Throwaway Irys instance not Set. Please call SetIrys()');
    }

    let instance = useThrowaway ? throwawayInstance : irysInstance;

    const size = data instanceof File ? data.size : (new TextEncoder().encode(data)).length;

    // check size is below 100kb
    const kB = 1024;
    if (size > 100 * kB) {
      throw new Error('Data size too large. Must be less than 100kb');
    }
  
    if (isBrowser && data instanceof File) {
      const { id } = await instance.uploadFile(data as string & File, {
        tags
      });
  
      return id;
    } else if (typeof data === 'string') {
      const { id } = await instance.upload(data, {
        tags
      });
  
      return id;
    } 
  } catch (e) {
    console.log(e);
    return undefined;
  }
}
