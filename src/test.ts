import { Client, fetchExchange } from "@urql/core";
import { findAvailableOperators, findByIdDocument, setProvider } from ".";

(async () => {
  await setProvider({ privateKeyFile: './dev-metamask-pk' })
  const client = new Client({
    url: 'https://arweave.net/graphql',
    exchanges: [fetchExchange],
  });
  const { data: scriptData } = await client.query(findByIdDocument, { ids: [ "VpRvG_kfkiyRl9kLHr5CQA-y6B5rHiEJYMqAO5uknbI" ] });

  if (!scriptData?.transactions.edges || scriptData.transactions.edges.length === 0) {
    throw new Error('Script not found');
  }
  await findAvailableOperators(scriptData);
})();