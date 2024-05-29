import { Query } from "@irys/query";
import { isNode } from "browser-or-node";
import { postOnArweave } from "./irys.js";
import { decodeTxMemo, getConnectedAddress, getUsdcReceivedLogs, getUsdcSentLogs, sendUSDC } from "./evm";
import { graphql } from "./gql/gql";
import { Client, fetchExchange } from '@urql/core';
import { hexToBigInt } from "viem";
import { MARKETPLACE_EVM_ADDRESS, REGISTRATION_USDC_FEE } from "./constants.js";
import { findByIdQuery } from "./gql/graphql.js";

const client = new Client({
  url: 'https://arweave.net/graphql',
  exchanges: [fetchExchange],
});

const queryClient = new Query();

const query = graphql(`
  query findByTags($tags: [TagFilter!], $first: Int!, $after: String) {
    transactions(
      tags: $tags
      first: $first
      after: $after
      sort: HEIGHT_DESC
    ) {
      pageInfo {
        hasNextPage
      }
      edges {
        cursor
        node {
          id
          tags {
            name
            value
          }
          owner {
            address
            key
          }
        }
      }
    }
  }
`);

const queryByTagsAndOwners = graphql(`
  query findByTagsAndOwners($tags: [TagFilter!], $owners: [String!], $first: Int!, $after: String) {
    transactions(
      tags: $tags
      first: $first
      after: $after
      owners: $owners
      sort: HEIGHT_DESC
    ) {
      pageInfo {
        hasNextPage
      }
      edges {
        cursor
        node {
          id
          tags {
            name
            value
          }
          owner {
            address
            key
          }
        }
      }
    }
  }
`);

const queryById = graphql(`
  query findById($ids: [ID!]) {
    transactions(
      ids: $ids
      sort: HEIGHT_DESC
    ) {
      pageInfo {
        hasNextPage
      }
      edges {
        cursor
        node {
          id
          tags {
            name
            value
          }
          owner {
            address
            key
          }
        }
      }
    }
  }
`);

const validateRegistration = async (operatorEvmAddress: `0x${string}`, registrationTx: string, timestamp: number) => {
  const blockRange = 2500;
  const logs = await getUsdcSentLogs(operatorEvmAddress, MARKETPLACE_EVM_ADDRESS, REGISTRATION_USDC_FEE, timestamp, blockRange);

  for (const log of logs) {
    const arweaveTx = await decodeTxMemo(log.transactionHash!);

    if (arweaveTx === registrationTx) {
      return true;
    }
  }

  return false;
};

export const countStamps = async (txids: string[]) => {
  const { data: stampsData } = await client.query(query, {
    tags: [
      { name: 'Protocol-Name', values: [ 'Stamp' ]},
      { name: 'Data-Source', values: txids },
    ],
    first: 100,
  });

  if (!stampsData?.transactions.edges || stampsData.transactions.edges.length === 0) {
    return undefined;
  }

  // group by source (aka stamped tx)
  const stampsCount = stampsData.transactions.edges.reduce((acc, tx) => {
    const source = tx.node.tags.find(tag => tag.name === 'Data-Source')?.value;
    
    if (!source) {
      return acc;
    } else if (acc[source]) {
      acc[source]++;
    } else {
      acc[source] = 1;
    }
    return acc;
  }, {} as Record<string, number>);

  return stampsCount;
};

export const findAvailableOperators = async (solution: findByIdQuery) => {
  const { data: operatorData } = await client.query(query, {
    tags: [
      {
        name: 'Protocol-Name',
        values: ['FairAI'],
      },
      {
        name: 'Protocol-Version',
        values: ['2.0'],
      },
      {
        name: 'Operation-Name',
        values: ['Operator Registration'],
      },
      {
        name: 'Solution-Transaction',
        values: [solution.transactions.edges[0].node.id],
      },
    ],
    first: 100,
  });

  const ids = operatorData?.transactions.edges.map(op => op.node.id) ?? [];

  const { data: cancellationData } = await client.query(query, {
    tags: [
      {
        name: 'Protocol-Name',
        values: ['FairAI'],
      },
      {
        name: 'Protocol-Version',
        values: ['2.0'],
      },
      {
        name: 'Operation-Name',
        values: ['Operator Cancellation'],
      },
      {
        name: 'Registration-Transaction',
        values: ids,
      },
    ],
    first: 100,
  });

  const { data: proofData } = await client.query(queryByTagsAndOwners, {
    tags: [
      {
        name: 'Protocol-Name',
        values: ['FairAI'],
      },
      {
        name: 'Protocol-Version',
        values: ['2.0'],
      },
      {
        name: 'Operation-Name',
        values: ['Operator Active Proof'],
      },
    ],
    owners: operatorData?.transactions.edges.map(op => op.node.owner.address) ?? [],
    first: 100,
  });

  // get registrations that have not been cancelled & have active proof
  const availableOperators = operatorData?.transactions.edges.filter((op) =>
    !cancellationData?.transactions.edges.find(
      cancellation => cancellation.node.owner.address === op.node.owner.address && cancellation.node.tags.find(tag => tag.name === 'Registration-Transaction' && tag.value === op.node.id)
    ) && proofData?.transactions.edges.find(
      proof => proof.node.owner.address === op.node.owner.address && Number(proof.node.tags.find(tag => tag.name === 'Unix-Time')?.value) > ((Date.now() / 1000) - (30 * 60)) // needs valid proof in the last 30 min
    )
  );

  if (!availableOperators || availableOperators.length === 0) {
    return [];
  }

  // validate previous requests
  const filtered = [];

  for (const operator of availableOperators) {
    // operator fee
    const operatorFee = Number(operator.node.tags.find(tag => tag.name === 'Operator-Fee')?.value);
      
    // operator evm wallet
    const operatorEvmResult = await getLinkedEvmWallet(operator.node.owner.address);
    const solutionRewardssAddress = solution.transactions.edges[0].node.tags.find(tag => tag.name === 'Rewards-EVM-Address')?.value as `0x${string}` | undefined;

    const timestamp = Number(operator.node.tags.find(tag => tag.name === 'Unix-Time')?.value);
    // validate operator paid registration fee && distributed fees for requests received
    if (operatorEvmResult?.evmWallet && await validateRegistration(operatorEvmResult.evmWallet, operator.node.id, timestamp) && await validateDistributionFees(operatorEvmResult?.evmWallet, operator.node.owner.address, operatorFee, timestamp, solutionRewardssAddress)) {
      filtered.push({ tx: operator, evmWallet: operatorEvmResult?.evmWallet, evmPublicKey: operatorEvmResult?.publicKey, arweaveWallet: operator.node.owner.address, operatorFee });
    }
  }

  // order by stamps
  const stampsCount = await countStamps(filtered.map(op => op.tx.node.id) ?? []);

  if (!stampsCount) {
    return filtered;
  }

  // return filtered operators sorted by stamps
  filtered.sort((a, b) => {
    const aTxid = a.tx.node.id;
    const bTxid = b.tx.node.id;

    return stampsCount[aTxid] - stampsCount[bTxid];
  });

  return filtered;
}

export const getLinkedEvmWallet = async (arweaveWallet: string) => {
  const { data: evmData } = await client.query(queryByTagsAndOwners, {
    tags: [
      {
        name: 'Protocol-Name',
        values: ['FairAI'],
      },
      {
        name: 'Protocol-Version',
        values: ['2.0'],
      },
      { name: 'Operation-Name', values: ['EVM Wallet Link'] },
    ],
    owners: [arweaveWallet],
    first: 1,
  });

  if (!evmData?.transactions.edges || evmData.transactions.edges.length === 0) {
    return undefined;
  } else {
    const response = await fetch('https://arweave.net/' + evmData.transactions.edges[0].node.id);
    const evmWallet = await response.text() as `0x${string}`;
    const publicKey = evmData.transactions.edges[0].node.tags.find(tag => tag.name === 'EVM-Public-Key')?.value;
    return evmWallet.substring(0, 2) === '0x' && publicKey ? { evmWallet, publicKey } : undefined;
  }
};

export const startConversation = async (solutionId: string, newCid: string) => {
  const tags = [
    {
      name: 'Protocol-Name',
      value: 'FairAI',
    },
    {
      name: 'Protocol-Version',
      value: '2.0',
    },
    {
      name: 'Operation-Name',
      value: 'Conversation Start',
    },
    {
      name: 'Solution-Transaction',
      value: solutionId,
    },
    {
      name: 'Unix-Time',
      value: (Date.now() / 1000).toString(),
    },
    {
      name: 'Conversation-Identifier',
      value: newCid,
    },
  ];

  await postOnArweave('Conversation Start', tags);
};

interface Configuration {
  assetNames?: string[];
  customTags?: { name: string; value: string }[];
  negativePrompt?: string;
  nImages?: number;
  title?: string;
  description?: string;
  width?: number;
  height?: number;
  requestCaller?: string;
  privateMode?: boolean;
  userPubKey?: string;
  encDataForOperator?: string;
  modelName: string;
  promptHistory?: string;
}

const addConfigTags = (tags: { name: string, value: string }[], configuration: Configuration, userAddr: string) => {
  if (configuration.assetNames) {
    tags.push({ name: 'Asset-Names', value: JSON.stringify(configuration.assetNames) });
  }

  if (configuration.negativePrompt) {
    tags.push({ name: 'Negative-Prompt', value: configuration.negativePrompt });
  }

  if (configuration.description) {
    tags.push({ name: 'Description', value: configuration.description });
  }

  if (configuration.customTags && configuration.customTags?.length > 0) {
    tags.push({ name: 'User-Custom-Tags', value: JSON.stringify(configuration.customTags) });
  }

  if (configuration.nImages && configuration.nImages > 0 && configuration.nImages < 10) {
    tags.push({ name: 'N-Images', value: configuration.nImages.toString() });
  }

  if (configuration.width && configuration.width > 0) {
    tags.push({ name: 'Images-Width', value: configuration.width.toString() });
  }

  if (configuration.height && configuration.height > 0) {
    tags.push({ name: 'Images-Height', value: configuration.height.toString() });
  }

  if (configuration.requestCaller) {
    tags.push({ name: 'Request-Caller', value: configuration.requestCaller });
  } else {
    tags.push({ name: 'Request-Caller', value: userAddr });
  }

  if (configuration.privateMode) {
    tags.push({ name: 'Private-Mode', value: 'true' });
  }

  if (configuration.encDataForOperator) {
    tags.push({ name: 'Encrypted-Data-For-Operator', value: configuration.encDataForOperator });
  }

  if (configuration.userPubKey) {
    tags.push({ name: 'User-Public-Key', value: configuration.userPubKey });
  }

  if (configuration.modelName) {
    tags.push({ name: 'Model-Name', value: configuration.modelName });
  }

  if (configuration.promptHistory) {
    tags.push({ name: 'Prompt-History', value: configuration.promptHistory });
  }
};

export const prompt = async (data: string | File, solutionTx: string, operator?: { arweaveWallet: string, evmWallet: `0x${string}`, operatorFee: number }, cid?: number, config?: Configuration) => {
  
  const wallet = await getConnectedAddress();

  if (!cid) {
    const [ lastConversation ] = await queryClient.search('irys:transactions').tags([
      {
        name: 'Protocol-Name',
        values: ['FairAI'],
      },
      {
        name: 'Protocol-Version',
        values: ['2.0'],
      },
      {
        name: 'Operation-Name',
        values: ['Conversation Start'],
      },
      {
        name: 'Solution-Transaction',
        values: [solutionTx],
      },
    ]).from([ wallet ]).sort('DESC').limit(1);
    cid = lastConversation ? Number(lastConversation.tags.find((tag: { name: string; value: string }) => tag.name === 'Conversation-Identifier')?.value) : 1;
  }
  
  const { data: solutionData } = await client.query(queryById, { ids: [ solutionTx ] });

  if (!solutionData?.transactions.edges || solutionData.transactions.edges.length === 0) {
    throw new Error('Solution not found');
  }

  let result;
  if (!operator) {

    [ result ] = await findAvailableOperators(solutionData); // get top of the list

    if (!result) {
      throw new Error('No operators available');
    }
  } else {
    result = operator;
  }

  const { evmWallet: operatorEvmWallet, operatorFee } = result;

  const tags: { name: string; value: string }[] = [];
  tags.push({ name: 'Protocol-Name', value: 'FairAI' });
  tags.push({ name: 'Protocol-Version', value: '2.0' });
  tags.push({ name: 'Solution-Transaction', value: solutionTx });
  tags.push({ name: 'Solution-Operator', value: result.arweaveWallet });
  tags.push({ name: 'Operation-Name', value: 'Inference Request' });
  tags.push({ name: 'Conversation-Identifier', value: `${cid}` });

  const tempDate = Date.now() / 1000;
  tags.push({ name: 'Unix-Time', value: tempDate.toString() });
  tags.push({ name: 'Content-Type', value: data instanceof File ? data.type : 'text/plain' });
  if (isNode) {
    tags.push({ name: 'Transaction-Origin', value: 'FairAI Node' });
  } else {
    tags.push({ name: 'Transaction-Origin', value: 'FairAI Browser' });
  }

  tags.push({ name: 'License', value: '' });
  tags.push({ name: 'Derivation', value: 'Allowed-With-License-Passthrough' });
  tags.push({ name: 'Commercial-Use', value: 'Allowed' });

  if (config) {
    addConfigTags(tags, config, wallet);
  }

  const requestId = await postOnArweave(data, tags);

  if (!requestId) {
    throw new Error('Could not upload to arweave');
  }

  let finalFee = operatorFee;
  
  if (config?.nImages && (config.nImages > 1 || config.nImages < 10)) {
    finalFee *= config.nImages;
  }

  const evmId = await sendUSDC(operatorEvmWallet, finalFee, requestId);

  return { arweaveTxId: requestId, evmTxId: evmId };
}

export const validateDistributionFees = async (targetAddress: `0x${string}`, targetArweaveAddr: string, fee: number, timestamp: number, curatorEvmAddr?: `0x${string}`) => {
  const blockRange = 2500;
  const logs = await getUsdcReceivedLogs(targetAddress, timestamp, blockRange);

  const latestLog = logs.pop();

  if (!latestLog) {
    return true;
  }

  const receivedFee = hexToBigInt(latestLog.data);
  const arweaveTx = await decodeTxMemo(latestLog.transactionHash);

  if (!arweaveTx) {
    return true;
  }
  const [ request ] = await queryClient.search('irys:transactions').ids([ arweaveTx ]).limit(1);

  const nImages = Number(request.tags.find(tag => tag.name === 'N-Images')?.value ?? '1');
  const requestTimestamp = Number(request.tags.find(tag => tag.name === 'Unix-Time')?.value ?? '0');

  const expectedFee = nImages * fee;

  if (expectedFee > Number(receivedFee)) {
    throw true; // if operator did not receive enough fees then is valid
  }

  // find answer to tx
  const { data: responseData } = await client.query(queryByTagsAndOwners, {
    tags: [
      { name: 'Protocol-Name', values: [ 'FairAI' ] },
      { name: 'Protocol-Version', values: [ '2.0' ] },
      {
        name: 'Request-Transaction',
        values: [ arweaveTx ],
      },
      { 
        name: 'Operation-Name',
        values: [ 'Inference Response' ]
      },
    ],
    owners: [ targetArweaveAddr ],
    first: nImages,
  });

  if (!responseData?.transactions.edges || responseData.transactions.edges.length !== nImages) {
    return false; // if operator did not respond to all images then validation false
  }

  // distributed fees
  // curator amount 
  if (curatorEvmAddr) {
    const [ curatorLog ] = await getUsdcSentLogs(targetAddress, curatorEvmAddr, expectedFee * 0.2, requestTimestamp, blockRange);

    if (!curatorLog) {
      return false; // validation false if there is no payment for curator
    }
  }
  const [ marketplaceLog ] = await getUsdcSentLogs(targetAddress, MARKETPLACE_EVM_ADDRESS, expectedFee * 0.1, requestTimestamp, blockRange);

  return !!marketplaceLog; // validation true if there are payments for curator and marketplace
};
