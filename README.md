
## Preparation
```bash
npm install
cp .env.example .env      
forge install foundry-rs/forge-std
```

## Hook compilation and testing
```bash
forge build
forge test -vv
```

## Deploy (Sepolia)
```bash
forge create src/SlidingWindowSpendingHook.sol:SlidingWindowSpendingHook \
  --rpc-url $SEPOLIA_RPC --private-key $DEPLOYER_KEY --broadcast
```


## Installing to the account and probe
```bash
npm run install-hook
```

## Testing the sliding window
```bash
npx tsx src/window-test.ts


```
