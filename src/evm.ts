import { NATIVE_USDC_ARB } from "./constants";
import { isBrowser, isNode } from "browser-or-node";
import fs from 'fs/promises';
import { ChainEIP712, arbitrum } from 'viem/chains';
import type { EIP1193Provider, Log } from 'viem';
import { formatEther, formatUnits, hexToBigInt, hexToString, parseEther, parseUnits, stringToHex } from 'viem/utils';
import { getContract, PublicClient, WalletClient, createPublicClient, createWalletClient, custom, encodeFunctionData,  http, erc20Abi, webSocket} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN = arbitrum;

let walletClient: WalletClient;
let throwawayClient: WalletClient;
let publicClient: PublicClient;

interface NodeProvider {
  providerUrl?: string,
  privateKeyFile?: string
}

export const setProvider = async (provider?: NodeProvider | EIP1193Provider) => {
  if (isBrowser && (provider || window?.ethereum)) {
    const [ account ] = await (provider as EIP1193Provider || window.ethereum).request({ method: 'eth_requestAccounts' });

    walletClient = createWalletClient({
      account,
      chain: CHAIN,
      transport: custom(provider as EIP1193Provider || window.ethereum)
    });
    publicClient = createPublicClient({
      chain: CHAIN,
      transport: custom(provider as EIP1193Provider || window.ethereum)
    });
  } else if (isNode && !(provider as NodeProvider)?.privateKeyFile) {
    throw new Error('Private key file not provided');
  } else if (isNode) {
    const privateKey = await fs.readFile((provider as NodeProvider)?.privateKeyFile!, 'utf-8');

    const account = privateKeyToAccount(`0x${privateKey}`);
    
    const isWebSocketUrl = (provider as NodeProvider)?.providerUrl?.startsWith('wss:');
    const isHttpUrl = (provider as NodeProvider)?.providerUrl?.startsWith('https:');

    if (!!(provider as NodeProvider)?.providerUrl && !isWebSocketUrl && !isHttpUrl) {
      throw new Error('Invalid provider url. Must be a valid http or wss url');
    } else if (!(provider as NodeProvider)?.providerUrl) {
      // if no provider passed, default to public arbitrum rpc
      walletClient = createWalletClient({
        chain: CHAIN,
        account,
        transport: http('https://arb1.arbitrum.io/rpc'),
      });
      publicClient = createPublicClient({
        chain: CHAIN,
        transport: http('https://arb1.arbitrum.io/rpc'),
      });
    } else {
      const transport = isWebSocketUrl ? webSocket((provider as NodeProvider)?.providerUrl) : http((provider as NodeProvider)?.providerUrl);
      walletClient = createWalletClient({
        chain: CHAIN,
        account,
        transport
      });
      publicClient = createPublicClient({
        chain: CHAIN,
        transport
      });
    }
  } else {
    throw new Error('Provider not available');
  }
}

export const setThrowawayProvider = (privateKey: `0x${string}`) => {
  const account = privateKeyToAccount(privateKey);
  // if no provider passed, default to public arbitrum rpc
  throwawayClient = createWalletClient({
    chain: CHAIN,
    account,
    transport: http('https://arb1.arbitrum.io/rpc'),
  });
}

export const getCurrentChainId = async () => {
  if (!walletClient || !publicClient) {
    throw new Error('Client Not Initialized. Please Call setProvider()');
  }

  return walletClient.getChainId();
};

export const switchChain = (chain: ChainEIP712) => {
  if (!walletClient || !publicClient) {
    throw new Error('Client Not Initialized. Please Call setProvider()');
  }

  try {
    walletClient.switchChain({ id: chain.id });  
  } catch (error) {
    walletClient.addChain({ chain });
    walletClient.switchChain({ id: chain.id});
  }

  return;
};

export const getConnectedAddress = (useThrowaway = false) => {
  if (useThrowaway && (!throwawayClient || !throwawayClient.account)) {
    throw new Error('Throwaway Client Not Initialized. Please Call setThrowawayProvider()');
  } else if (!useThrowaway && (!walletClient || !walletClient.account)) {
    throw new Error('Client Not Initialized. Please Call setProvider()');
  } else if (useThrowaway) {
    return throwawayClient.account?.address!;
  } else {
    return walletClient.account?.address!;
  }
}

export const decodeTxMemo = async (tx: `0x${string}`) => {
  // get tx data
  const transaction = await publicClient.getTransaction({ 
    hash: tx
  });

  const data = transaction.input;
  const memoSliceStart = 138;// 0x + function selector 4bytes-8chars + 2 32bytes arguments = 138 chars;
  const hexMemo = data.substring(memoSliceStart, data.length);

  return hexToString(`0x${hexMemo}`);
};

export const getUsdcBalance = async () => {
  if (!walletClient || !publicClient) {
    throw new Error('Client Not Initialized. Please Call setProvider()');
  }

  const contract = getContract({
    address: NATIVE_USDC_ARB,
    abi: erc20Abi,
    client: { wallet: walletClient, public: publicClient }
  });

  const userAddr = (await walletClient.getAddresses())[0];
  const balance = await contract.read.balanceOf([ userAddr ]);
  const decimals = await contract.read.decimals();
  if (typeof balance === 'bigint' && typeof decimals === 'number') {
    return Number(formatUnits(balance, decimals));
  }

  return 0;
}

export const getUsdcAllowance = async (owner: `0x${string}`, spender: `0x${string}`) => {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: CHAIN,
      transport: http('https://arb1.arbitrum.io/rpc'),
    });
  }

  const contract = getContract({
    address: NATIVE_USDC_ARB,
    abi: erc20Abi,
    client: { public: publicClient }
  });

  const allowance = await contract.read.allowance([ owner, spender ]);
  const decimals = await contract.read.decimals();
  if (typeof allowance === 'bigint' && typeof decimals === 'number') {
    return Number(formatUnits(allowance, decimals));
  }

  return 0;
}

export const getEthBalance = async (walletAddr?: `0x${string}`) => {
  if (!walletClient || !publicClient) {
    throw new Error('Client Not Initialized. Please Call setProvider()');
  }

  const userAddr = walletAddr ?? (await walletClient.getAddresses())[0];
  const balance = await publicClient.getBalance({ address: userAddr });
  
  return Number(formatEther(balance));
}

export const sendEth = async (target: `0x${string}`, amount: number) => {
  if (!walletClient || !walletClient.account) {
    throw new Error('Client Not Initialized. Please Call setProvider()');
  }

  const result = walletClient.sendTransaction({
    chain: CHAIN,
    account: walletClient.account,
    to: target,
    value: parseEther(amount.toString())
  });

  return result;
};

export const sendUSDC = async (target: `0x${string}`, amount: number, arweaveTx: string) => {
  if (!walletClient || !publicClient) {
    throw new Error('Client Not Set. Please Call setProvider()');
  }

  // Convert the amount to send to decimals (6 decimals for USDC)
  const contract = getContract({
    address: NATIVE_USDC_ARB,
    abi: erc20Abi,
    client: {
      wallet: walletClient,
      public: publicClient
    }
  });

  // const balance = await contract.read.balanceOf([ userAddr ]);
  const decimals = (await contract.read.decimals()) as number;
  const amountParsed = parseUnits(amount.toString(), decimals);

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [ target, amountParsed ]
  });

  const memo = stringToHex(arweaveTx).slice(2); // 0x prefix is removed

  let {
    maxFeePerGas,
    maxPriorityFeePerGas
  } = await publicClient.estimateFeesPerGas();
  
  if (!maxPriorityFeePerGas) {
    // use a third of the max fee as the priority fee
    maxPriorityFeePerGas = maxFeePerGas;
  }

  const request = await walletClient.prepareTransactionRequest({
    account: walletClient.account!,
    to: NATIVE_USDC_ARB,
    chain: CHAIN,
    maxFeePerGas,
    maxPriorityFeePerGas,
    data: `${data}${memo}`, // encoded data for the transaction (transfer call plus arweave memo)
  });

  if (isBrowser) {
    const receipt = await walletClient.sendTransaction(request);
    return receipt;
  } else {
    const serializedTransaction = await walletClient.signTransaction(request);
    const hash = await walletClient.sendRawTransaction({ serializedTransaction });

    return hash;
  }
}

export const sendThrowawayUSDC = async (sender: `0x${string}`, target: `0x${string}`, amount: number, arweaveTx: string) => {
  if (!throwawayClient) {
    throw new Error('Throwaway Client Not Set. Please Call setThrowawayProvider()');
  }

  // Convert the amount to send to decimals (6 decimals for USDC)
  const contract = getContract({
    address: NATIVE_USDC_ARB,
    abi: erc20Abi,
    client: {
      wallet: throwawayClient,
      public: publicClient
    }
  });

  // const balance = await contract.read.balanceOf([ userAddr ]);
  const decimals = (await contract.read.decimals()) as number;
  const amountParsed = parseUnits(amount.toString(), decimals);

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transferFrom',
    args: [ sender, target, amountParsed ]
  });

  const memo = stringToHex(arweaveTx).slice(2); // 0x prefix is removed

  let {
    maxFeePerGas,
    maxPriorityFeePerGas
  } = await publicClient.estimateFeesPerGas();
  
  if (!maxPriorityFeePerGas) {
    // use a third of the max fee as the priority fee
    maxPriorityFeePerGas = maxFeePerGas;
  }

  const request = await throwawayClient.prepareTransactionRequest({
    account: throwawayClient.account!,
    to: NATIVE_USDC_ARB,
    chain: CHAIN,
    maxFeePerGas,
    maxPriorityFeePerGas,
    data: `${data}${memo}`, // encoded data for the transaction (transfer call plus arweave memo)
  });
  

  const serializedTransaction = await throwawayClient.signTransaction(request);
  const hash = await throwawayClient.sendRawTransaction({ serializedTransaction });

  return hash;
}

type callbackFn = (logs: Log[]) => void;

export const subscribe = (targetAddress: `0x${string}`, callback: callbackFn) => {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: CHAIN,
      transport: http('https://arb1.arbitrum.io/rpc'),
    });
  }

  return publicClient.watchContractEvent({
    abi: erc20Abi,
    address: NATIVE_USDC_ARB,
    eventName: 'Transfer',
    args: {  
      to: targetAddress
    },
    onLogs: callback,
  });
}

export const getUsdcReceivedLogs = async (targetAddress: `0x${string}`, timestamp: number, limit?: number) => {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: CHAIN,
      transport: http('https://arb1.arbitrum.io/rpc'),
    });
  }

  const result = await fetch(`https://coins.llama.fi/block/arbitrum/${timestamp}`);
  const { height: nearestBlockNumber } = await result.json();

  const toBlock: bigint | 'latest' = limit ? BigInt(nearestBlockNumber + limit) : 'latest';
  // calculate block at which to start looking for logs (1 month)s
  // const startBlock = blockNumber + ()
  // geet all usdc transfers received by target address
  const logs = await publicClient.getContractEvents({
    address: NATIVE_USDC_ARB,
    abi: erc20Abi,
    eventName: 'Transfer',
    args: {
      to: targetAddress
    },
    fromBlock: BigInt(nearestBlockNumber - 10),
    toBlock,
  });

  return logs;
};

export const getUsdcSentLogs = async (senderAddr: `0x${string}`, targetAddress?: `0x${string}`, amount?: number, timestamp?: number, limit?: number) => {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: CHAIN,
      transport: http('https://arb1.arbitrum.io/rpc'),
    });
  }

  const result = await fetch(`https://coins.llama.fi/block/arbitrum/${timestamp}`);
  const { height: nearestBlockNumber } = await result.json();
  const toBlock: bigint | 'latest' = limit ? BigInt(nearestBlockNumber + limit) : 'latest';
  // calculate block at which to start looking for logs (1 month)
  // const startBlock = blockNumber + ()
  // geet all usdc transfers received by target address
  const logs = await publicClient.getContractEvents({
    address: NATIVE_USDC_ARB,
    abi: erc20Abi,
    eventName: 'Transfer',
    args: {
      from: senderAddr,
      to: targetAddress,
    },
    strict: true,
    fromBlock: BigInt(nearestBlockNumber - 10),
    toBlock,
  });

  if (amount) {
    const amoundInUsdc = parseUnits(amount.toString(), 6);
    return logs.filter((log) => hexToBigInt(log.data) === amoundInUsdc);
  } else {
    return logs;
  }
};

export const allowUsdc = async (spender: `0x${string}`, amount: number) => {
  if (!walletClient || !publicClient) {
    throw new Error('Client Not Set. Please Call setProvider()');
  }

  // Convert the amount to send to decimals (6 decimals for USDC)
  const amountInUsdc = parseUnits(amount.toString(), 6);

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [ spender, amountInUsdc ],
  });

  let {
    maxFeePerGas,
    maxPriorityFeePerGas
  } = await publicClient.estimateFeesPerGas();
  
  if (!maxPriorityFeePerGas) {
    // use a third of the max fee as the priority fee
    maxPriorityFeePerGas = maxFeePerGas;
  }

  const request = await walletClient.prepareTransactionRequest({
    account: walletClient.account!,
    to: NATIVE_USDC_ARB,
    chain: CHAIN,
    maxFeePerGas,
    maxPriorityFeePerGas,
    data,
  });

  if (isBrowser) {
    const receipt = await walletClient.sendTransaction(request);
    return receipt;
  } else {
    const serializedTransaction = await walletClient.signTransaction(request);
    const hash = await walletClient.sendRawTransaction({ serializedTransaction });

    return hash;
  }
}
