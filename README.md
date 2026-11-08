# zerodev-hook-session-test

Kernel v3.1 okosszámla (Sepolia) + csúszóablakos 24 órás költési limit hook.

## Előkészítés
```bash
npm install
cp .env.example .env      # töltsd ki az értékeket
forge install foundry-rs/forge-std
```

## Hook fordítása és tesztelése
```bash
forge build
forge test -vv
```

## Deploy (Sepolia)
```bash
forge create src/SlidingWindowSpendingHook.sol:SlidingWindowSpendingHook \
  --rpc-url $SEPOLIA_RPC --private-key $DEPLOYER_KEY --broadcast
```
A kapott címet írd a `.env`-be `HOOK_ADDRESS`-ként.

## Telepítés az accountra és próba
```bash
npm run install-hook
```
