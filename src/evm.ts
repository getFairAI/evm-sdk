import { USDC_ARB_SEPOLIA } from "./constants.js";
import { isBrowser, isNode } from "browser-or-node";
import fs from 'fs/promises';
import { arbitrumSepolia } from 'viem/chains';
import type { Log } from 'viem';
import { formatEther, formatUnits, hexToBigInt, hexToString, parseGwei, parseUnits, stringToHex } from 'viem/utils';
import { getContract, PublicClient, WalletClient, createPublicClient, createWalletClient, custom, encodeFunctionData,  http, erc20Abi, webSocket} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN = arbitrumSepolia; /* process.env.ENV === 'develzopment' ? arbitrumSepolia : arbitrum; */

let walletClient: WalletClient;
let publicClient: PublicClient;

export const getProvider = () => {
  if (!walletClient || !publicClient) {
    throw new Error('Client Not Initialized. Please Call setProvider()');
  }

  return { walletClient, publicClient };
};

export const setProvider = async (params?: { providerUrl: string, privateKeyFile: string } ) => {

  if (isBrowser && window?.ethereum) {
    const [ account ] = await window.ethereum.request({ method: 'eth_requestAccounts' });

    walletClient = createWalletClient({
      account,
      chain: CHAIN,
      transport: custom(window.ethereum)
    });
    publicClient = createPublicClient({
      chain: CHAIN,
      transport: custom(window.ethereum)
    });
  } else if (isNode && !params?.privateKeyFile) {
    throw new Error('Private key file not provided');
  } else if (isNode) {
    const privateKey = await fs.readFile(params?.privateKeyFile!, 'utf-8');

    const account = privateKeyToAccount(`0x${privateKey}`);
    
    const isWebSocketUrl = params?.providerUrl.startsWith('wss:');
    const isHttpUrl = params?.providerUrl.startsWith('https:');

    if (!!params?.providerUrl && !isWebSocketUrl && !isHttpUrl) {
      throw new Error('Invalid provider url. Must be a valid http or wss url');
    } else if (!params?.providerUrl) {
      // if no provider passed, default to public arbitrum rpc
      walletClient = createWalletClient({
        chain: CHAIN,
        account,
        transport: http('https://sepolia-rollup.arbitrum.io/rpc'),
      });
      publicClient = createPublicClient({
        chain: CHAIN,
        transport: http('https://sepolia-rollup.arbitrum.io/rpc'),
      });
    } else {
      const transport = isWebSocketUrl ? webSocket(params?.providerUrl) : http(params?.providerUrl);
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


export const getConnectedAddress = async () => {
  if (!walletClient) {
    throw new Error('Client Not Initialized. Please Call setProvider()');
  }

  return (await walletClient.getAddresses())[0];
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
    address: USDC_ARB_SEPOLIA,
    abi: erc20Abi,
    client: { wallet: walletClient, public: publicClient }
  });

  const userAddr = (await walletClient.getAddresses())[0];
  const ethBalance = await publicClient.getBalance({ address: userAddr });
  console.log(`ETH Balance: ${ethBalance}`);

  const balance = await contract.read.balanceOf([ userAddr ]);
  const decimals = await contract.read.decimals();
  const symbol = await contract.read.symbol();
  if (typeof balance === 'bigint' && typeof decimals === 'number') {
    console.log(`Balance: ${formatUnits(balance, decimals)} ${symbol}`);
    return Number(formatUnits(balance, decimals));
  }

  return 0;
}

export const getEthBalance = async () => {
  if (!walletClient || !publicClient) {
    throw new Error('Client Not Initialized. Please Call setProvider()');
  }

  const userAddr = (await walletClient.getAddresses())[0];
  const balance = await publicClient.getBalance({ address: userAddr });
  
  return Number(formatEther(balance));
}

export const sendUSDC = async (target: `0x${string}`, amount: number, arweaveTx: string) => {
  if (!walletClient || !publicClient) {
    throw new Error('Client Not Set. Please Call setProvider()');
  }

  // Convert the amount to send to decimals (6 decimals for USDC)
  const contract = getContract({
    address: USDC_ARB_SEPOLIA,
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
    to: USDC_ARB_SEPOLIA,
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

type callbackFn = (logs: Log[]) => void;

export const subscribe = async (targetAddress: `0x${string}`, callback: callbackFn) => {
  if (!publicClient) {
    throw new Error('Client Not Set. Please Call setProvider()');
  }

  return publicClient.watchContractEvent({
    abi: erc20Abi,
    address: USDC_ARB_SEPOLIA,
    eventName: 'Transfer',
    args: {  
      to: targetAddress
    },
    onLogs: callback,
  });
}

export const getUsdcReceivedLogs = async (targetAddress: `0x${string}`) => {
  if (!publicClient) {
    throw new Error('Client Not Set. Please Call setProvider()');
  }

  const blockNumber = await publicClient.getBlockNumber() 

  // calculate block at which to start looking for logs (1 month)
  // const startBlock = blockNumber + ()
  // geet all usdc transfers received by target address
  const logs = await publicClient.getContractEvents({
    address: USDC_ARB_SEPOLIA,
    abi: erc20Abi,
    eventName: 'Transfer',
    fromBlock: blockNumber - 1000000n,
    toBlock: 'latest',
    args: {
      to: targetAddress
    },
  });

  console.log(logs);
  return logs;
};

export const getUsdcSentLogs = async (senderAddr: `0x${string}`, targetAddress?: `0x${string}`, amount?: number) => {
  if (!publicClient) {
    throw new Error('Client Not Set. Please Call setProvider()');
  }

  const blockNumber = await publicClient.getBlockNumber() 

  // calculate block at which to start looking for logs (1 month)
  // const startBlock = blockNumber + ()
  // geet all usdc transfers received by target address
  const logs = await publicClient.getContractEvents({
    address: USDC_ARB_SEPOLIA,
    abi: erc20Abi,
    eventName: 'Transfer',
    fromBlock: blockNumber - 1000000n,
    toBlock: 'latest',
    args: {
      from: senderAddr,
      to: targetAddress,
    },
    strict: true,
  });

  if (amount) {
    const amoundInUsdc = parseUnits(amount.toString(), 6);
    return logs.filter((log) => hexToBigInt(log.data) === amoundInUsdc);
  } else {
    return logs;
  }
};
