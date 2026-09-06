export const PRODUCT = {
  name: "Agent",
  appId: "com.zhonghai10777.agent",
  githubOwner: "zhonghai10777-crypto",
  githubRepo: "agent",
} as const;

export const PRODUCT_REPOSITORY_URL =
  `https://github.com/${PRODUCT.githubOwner}/${PRODUCT.githubRepo}`;

/** Distribution can point at a public binary-only repo while source stays private. */
export const PRODUCT_UPDATE_REPOSITORY = "zhonghai10777-crypto/agent";
