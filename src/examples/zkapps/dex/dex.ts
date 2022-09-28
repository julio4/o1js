import {
  Account,
  Bool,
  Circuit,
  provable,
  CircuitValue,
  DeployArgs,
  Experimental,
  Field,
  Int64,
  isReady,
  method,
  Mina,
  AccountUpdate,
  Permissions,
  PrivateKey,
  prop,
  PublicKey,
  SmartContract,
  Token,
  UInt64,
  VerificationKey,
} from 'snarkyjs';

export { Dex, DexTokenHolder, TokenContract, keys, addresses, tokenIds };

class Dex extends SmartContract {
  // addresses of token contracts are constants
  tokenX = addresses.tokenX;
  tokenY = addresses.tokenY;

  /**
   * Mint liquidity tokens in exchange for X and Y tokens
   * @param user caller address
   * @param dx input amount of X tokens
   * @param dy input amount of Y tokens
   * @return output amount of lqXY tokens
   *
   * This function fails if the X and Y token amounts don't match the current X/Y ratio in the pool.
   * This can also be used if the pool is empty. In that case, there is no check on X/Y;
   * instead, the input X and Y amounts determine the initial ratio.
   *
   * The transaction needs to be signed by the user's private key.
   */
  @method supplyLiquidityBase(user: PublicKey, dx: UInt64, dy: UInt64): UInt64 {
    let tokenX = new TokenContract(this.tokenX);
    let tokenY = new TokenContract(this.tokenY);

    // get balances of X and Y token
    // TODO: this creates extra account updates. we need to reuse these by passing them to or returning them from transfer()
    // but for that, we need the @method argument generalization
    let dexX = AccountUpdate.create(this.address, tokenX.experimental.token.id);
    let x = dexX.account.balance.get();
    dexX.account.balance.assertEquals(x);

    let dexY = AccountUpdate.create(this.address, tokenY.experimental.token.id);
    let y = dexY.account.balance.get();
    dexY.account.balance.assertEquals(y);

    // assert dy == [dx * y/x], or x == 0
    let isXZero = x.equals(UInt64.zero);
    let xSafe = Circuit.if(isXZero, UInt64.one, x);
    dy.equals(dx.mul(y).div(xSafe)).or(isXZero).assertTrue();

    tokenX.transfer(user, this.address, dx);
    tokenY.transfer(user, this.address, dy);

    // calculate liquidity token output simply as dl = dx + dx
    // => maintains ratio x/l, y/l
    let dl = dy.add(dx);
    this.experimental.token.mint({ address: user, amount: dl });
    return dl;
  }

  /**
   * Mint liquidity tokens in exchange for X and Y tokens
   * @param user caller address
   * @param dx input amount of X tokens
   * @return output amount of lqXY tokens
   *
   * This uses supplyLiquidityBase as the circuit, but for convenience,
   * the input amount of Y tokens is calculated automatically from the X tokens.
   * Fails if the liquidity pool is empty, so can't be used for the first deposit.
   *
   * The transaction needs to be signed by the user's private key.
   */
  supplyLiquidity(user: PublicKey, dx: UInt64): UInt64 {
    // calculate dy outside circuit
    let x = Account(this.address, Token.getId(this.tokenX)).balance.get();
    let y = Account(this.address, Token.getId(this.tokenY)).balance.get();
    if (x.value.isZero().toBoolean()) {
      throw Error(
        'Cannot call `supplyLiquidity` when reserves are zero. Use `supplyLiquidityBase`.'
      );
    }
    let dy = dx.mul(y).div(x);
    return this.supplyLiquidityBase(user, dx, dy);
  }

  /**
   * Burn liquidity tokens to get back X and Y tokens
   * @param user caller address
   * @param dl input amount of lqXY token
   * @return output amount of X and Y tokens, as a tuple [outputX, outputY]
   *
   * The transaction needs to be signed by the user's private key.
   */
  @method redeemLiquidity(user: PublicKey, dl: UInt64): UInt64x2 {
    // call the token X holder inside a token X-authorized callback
    let tokenX = new TokenContract(this.tokenX);
    let dexX = new DexTokenHolder(this.address, tokenX.experimental.token.id);
    let dxdy = dexX.redeemLiquidity(user, dl, this.tokenY);
    tokenX.authorize(dexX.self);
    return dxdy;
  }

  /**
   * Swap X tokens for Y tokens
   * @param user caller address
   * @param dx input amount of X tokens
   * @return output amount Y tokens
   *
   * The transaction needs to be signed by the user's private key.
   */
  @method swapX(user: PublicKey, dx: UInt64): UInt64 {
    let tokenY = new TokenContract(this.tokenY);
    let dexY = new DexTokenHolder(this.address, tokenY.experimental.token.id);
    let dy = dexY.swap(user, dx, this.tokenX);
    tokenY.authorize(dexY.self);
    return dy;
  }

  /**
   * Swap Y tokens for X tokens
   * @param user caller address
   * @param dy input amount of Y tokens
   * @return output amount Y tokens
   *
   * The transaction needs to be signed by the user's private key.
   */
  @method swapY(user: PublicKey, dy: UInt64): UInt64 {
    let tokenX = new TokenContract(this.tokenX);
    let dexX = new DexTokenHolder(this.address, tokenX.experimental.token.id);
    let dx = dexX.swap(user, dy, this.tokenY);
    tokenX.authorize(dexX.self);
    return dx;
  }
}

// TODO: this is a pain -- let's define circuit values in one line, with a factory pattern
// we just have to make provable return a class, that's it!
// class UInt64x2 extends provable([UInt64, UInt64]) {}
class UInt64x2 extends CircuitValue {
  @prop 0: UInt64;
  @prop 1: UInt64;

  static from([a0, a1]: [UInt64, UInt64]) {
    return UInt64x2.fromObject({ 0: a0, 1: a1 });
  }
}

class DexTokenHolder extends SmartContract {
  // simpler circuit for redeeming liquidity -- direct trade between our token and lq token
  // it's incomplete, as it gives the user only the Y part for an lqXY token; but doesn't matter as there's no incentive to call it directly
  // see the more complicated method `redeemLiquidity` below which gives back both tokens, by calling this method,
  // for the other token, in a callback
  @method redeemLiquidityPartial(user: PublicKey, dl: UInt64): UInt64x2 {
    let dex = AccountUpdate.create(this.address);
    let l = dex.account.balance.get();
    dex.account.balance.assertEquals(l);

    // user sends dl to dex
    let idlXY = Token.getId(this.address);
    let userUpdate = AccountUpdate.create(user, idlXY);
    userUpdate.balance.subInPlace(dl);

    // in return, we give dy back
    let y = this.account.balance.get();
    this.account.balance.assertEquals(y);
    let dy = y.mul(dl).div(l);
    this.send({ to: user, amount: dy });

    // return l, dy so callers don't have to walk their child account updates to get it
    return UInt64x2.from([l, dy]);
  }

  // more complicated circuit, where we trigger the Y(other)-lqXY trade in our child account updates and then add the X(our) part
  @method redeemLiquidity(
    user: PublicKey,
    dl: UInt64,
    otherTokenAddress: PublicKey
  ): UInt64x2 {
    // first call the Y token holder, authorized by the Y token contract; this makes sure we get dl, the user's lqXY
    let tokenY = new TokenContract(otherTokenAddress);
    let dexY = new DexTokenHolder(this.address, tokenY.experimental.token.id);
    let result = dexY.redeemLiquidityPartial(user, dl);
    let l = result[0];
    let dy = result[1];
    tokenY.authorize(dexY.self);

    // in return for dl, we give back dx, the X token part
    let x = this.account.balance.get();
    this.account.balance.assertEquals(x);
    let dx = x.mul(dl).div(l);
    this.send({ to: user, amount: dx });

    return UInt64x2.from([dx, dy]);
  }

  // this works for both directions (in our case where both tokens use the same contract)
  @method swap(
    user: PublicKey,
    otherTokenAmount: UInt64,
    otherTokenAddress: PublicKey
  ): UInt64 {
    // we're writing this as if our token == y and other token == x
    let dx = otherTokenAmount;
    let tokenX = new TokenContract(otherTokenAddress);
    // send x from user to us (i.e., to the same address as this but with the other token)
    let dexX = tokenX.experimental.token.send({
      from: user,
      to: this.address,
      amount: dx,
    });
    // get balances
    let x = dexX.account.balance.get();
    dexX.account.balance.assertEquals(x);
    let y = this.account.balance.get();
    this.account.balance.assertEquals(y);
    // compute and send dy
    let dy = y.mul(dx).div(x.add(dx));
    this.send({ to: user, amount: dy });
    return dy;
  }
}

/**
 * Simple token with API flexible enough to handle all our use cases
 */
class TokenContract extends SmartContract {
  // constant supply
  SUPPLY = UInt64.from(10n ** 18n);

  deploy(args?: DeployArgs) {
    super.deploy(args);
    this.setPermissions({
      ...Permissions.default(),
      send: Permissions.proofOrSignature(),
    });
  }
  @method init() {
    // mint the entire supply to the token account with the same address as this contract
    let address = this.self.body.publicKey;
    let receiver = this.experimental.token.mint({
      address,
      amount: this.SUPPLY,
    });
    // assert that the receiving account is new, so this can be only done once
    receiver.account.isNew.assertEquals(Bool(true));
    // pay fees for opened account
    this.balance.subInPlace(Mina.accountCreationFee());
  }

  // this is a very standardized deploy method. instead, we could also take the account update from a callback
  // => need callbacks for signatures
  @method deployZkapp(address: PublicKey, verificationKey: VerificationKey) {
    let tokenId = this.experimental.token.id;
    let zkapp = Experimental.createChildAccountUpdate(
      this.self,
      address,
      tokenId
    );
    AccountUpdate.setValue(zkapp.update.permissions, {
      ...Permissions.default(),
      send: Permissions.proof(),
    });
    AccountUpdate.setValue(zkapp.update.verificationKey, verificationKey);
    zkapp.sign();
  }

  // let a zkapp do whatever it wants, as long as the token supply stays constant
  @method authorize(zkappUpdate: AccountUpdate) {
    let layout = [[[3, 0, 0], 0, 0]]; // these are 10 child account updates we allow, in a left-biased tree of width 3

    // adopt this account update as a child, allowing a certain layout for its own children
    this.experimental.authorize(zkappUpdate, layout);

    // walk account updates to see if balances for this token cancel
    let balance = balanceSum(zkappUpdate, this.experimental.token.id);
    balance.assertEquals(Int64.zero);
  }

  @method transfer(from: PublicKey, to: PublicKey, value: UInt64) {
    this.experimental.token.send({ from, to, amount: value });
  }
}

await isReady;
let { keys, addresses } = randomAccounts('tokenX', 'tokenY', 'dex', 'user');
let tokenIds = {
  X: Token.getId(addresses.tokenX),
  Y: Token.getId(addresses.tokenY),
  lqXY: Token.getId(addresses.dex),
};

/**
 * Sum of balances of the account update and all its descendants
 */
function balanceSum(accountUpdate: AccountUpdate, tokenId: Field) {
  let myTokenId = accountUpdate.body.tokenId;
  let myBalance = Int64.fromObject(accountUpdate.body.balanceChange);
  let balance = Circuit.if(myTokenId.equals(tokenId), myBalance, Int64.zero);
  for (let child of accountUpdate.children.accountUpdates) {
    balance.add(balanceSum(child, tokenId));
  }
  return balance;
}

/**
 * Random accounts keys, labeled by the input strings
 */
function randomAccounts<K extends string>(
  ...names: [K, ...K[]]
): { keys: Record<K, PrivateKey>; addresses: Record<K, PublicKey> } {
  let keys = Object.fromEntries(
    names.map((name) => [name, PrivateKey.random()])
  ) as Record<K, PrivateKey>;
  let addresses = Object.fromEntries(
    names.map((name) => [name, keys[name].toPublicKey()])
  ) as Record<K, PublicKey>;
  return { keys, addresses };
}
