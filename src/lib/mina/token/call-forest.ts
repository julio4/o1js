import { prefixes } from '../../../provable/poseidon-bigint.js';
import { AccountUpdate, TokenId } from '../../account_update.js';
import { Field } from '../../core.js';
import { Provable } from '../../provable.js';
import { Struct, Unconstrained } from '../../circuit_value.js';
import { assert } from '../../gadgets/common.js';
import { Poseidon, ProvableHashable } from '../../hash.js';
import { Hashed } from '../../provable-types/packed.js';
import {
  MerkleArray,
  MerkleListBase,
  MerkleList,
  genericHash,
  withHashes,
} from '../../provable-types/merkle-list.js';

export { CallForest, CallForestArray, CallForestIterator, hashAccountUpdate };

export { HashedAccountUpdate, CallForestUnderConstruction };

class HashedAccountUpdate extends Hashed.create(
  AccountUpdate,
  hashAccountUpdate
) {}

type CallTree = {
  accountUpdate: Hashed<AccountUpdate>;
  calls: MerkleListBase<CallTree>;
};
const CallTree: ProvableHashable<CallTree> = Struct({
  accountUpdate: HashedAccountUpdate.provable,
  calls: MerkleListBase<CallTree>(),
});

class CallForest extends MerkleList.create(CallTree, merkleListHash) {
  static fromAccountUpdates(updates: AccountUpdate[]): CallForest {
    let nodes = updates.map((update) => {
      let accountUpdate = HashedAccountUpdate.hash(update);
      let calls = CallForest.fromAccountUpdates(update.children.accountUpdates);
      return { accountUpdate, calls };
    });

    return CallForest.from(nodes);
  }
}

class CallForestArray extends MerkleArray.createFromList(CallForest) {}

class Layer extends Struct({
  forest: CallForestArray.provable,
  mayUseToken: AccountUpdate.MayUseToken.type,
}) {}
const ParentLayers = MerkleList.create<Layer>(Layer);

type MayUseToken = AccountUpdate['body']['mayUseToken'];
const MayUseToken = AccountUpdate.MayUseToken;

/**
 * Data structure to represent a forest tree of account updates that is being iterated over.
 *
 * Important: Since this is to be used for token manager contracts to process it's entire subtree
 * of account updates, the iterator skips subtrees that don't inherit token permissions.
 */
class CallForestIterator {
  currentLayer: Layer;
  unfinishedParentLayers: MerkleList<Layer>;
  selfToken: Field;

  constructor(
    forest: CallForestArray,
    mayUseToken: MayUseToken,
    selfToken: Field
  ) {
    this.currentLayer = { forest, mayUseToken };
    this.unfinishedParentLayers = ParentLayers.empty();
    this.selfToken = selfToken;
  }

  static create(forest: CallForest, selfToken: Field) {
    return new CallForestIterator(
      CallForestArray.startIterating(forest),
      MayUseToken.ParentsOwnToken,
      selfToken
    );
  }

  /**
   * Make a single step along a tree of account updates.
   *
   * This function is guaranteed to visit each account update in the tree that uses the token
   * exactly once, when called repeatedly.
   *
   * The method makes a best effort to avoid visiting account updates that are not using the token,
   * and in particular, to avoid returning dummy updates.
   * However, neither can be ruled out. We're returning { update, usesThisToken: Bool } and let the
   * caller handle the irrelevant case where `usesThisToken` is false.
   */
  next() {
    // get next account update from the current forest (might be a dummy)
    // and step down into the layer of its children
    let { accountUpdate, calls } = this.currentLayer.forest.next();
    let forest = CallForestArray.startIterating(calls);
    let parentForest = this.currentLayer.forest;

    this.unfinishedParentLayers.pushIf(parentForest.isAtEnd().not(), {
      forest: parentForest,
      mayUseToken: this.currentLayer.mayUseToken,
    });

    // check if this account update / it's children can use the token
    let update = accountUpdate.unhash();

    let canAccessThisToken = Provable.equal(
      MayUseToken.type,
      update.body.mayUseToken,
      this.currentLayer.mayUseToken
    );
    let isSelf = TokenId.derive(update.publicKey, update.tokenId).equals(
      this.selfToken
    );

    let usesThisToken = update.tokenId.equals(this.selfToken);

    // if we don't have to check the children, ignore the forest by jumping to its end
    let skipSubtree = canAccessThisToken.not().or(isSelf);
    forest.jumpToEndIf(skipSubtree);

    // if we're at the end of the current layer, step up to the next unfinished parent layer
    // invariant: the new current layer will _never_ be finished _except_ at the point where we stepped
    // through the entire forest and there are no remaining parent layers to finish
    let currentLayer = { forest, mayUseToken: MayUseToken.InheritFromParent };
    let currentIsFinished = forest.isAtEnd();

    let parentLayers = this.unfinishedParentLayers.clone();
    let nextParentLayer = this.unfinishedParentLayers.pop();
    let parentLayersIfSteppingUp = this.unfinishedParentLayers;

    this.currentLayer = Provable.if(
      currentIsFinished,
      Layer,
      nextParentLayer,
      currentLayer
    );
    this.unfinishedParentLayers = Provable.if(
      currentIsFinished,
      ParentLayers.provable,
      parentLayersIfSteppingUp,
      parentLayers
    );

    return { accountUpdate: update, usesThisToken };
  }

  assertFinished(message?: string) {
    assert(
      this.currentLayer.forest.isAtEnd(),
      message ?? 'CallForest not finished'
    );
  }
}

// how to hash a forest

function merkleListHash(forestHash: Field, tree: CallTree) {
  return hashCons(forestHash, hashNode(tree));
}

function hashNode(tree: CallTree) {
  return Poseidon.hashWithPrefix(prefixes.accountUpdateNode, [
    tree.accountUpdate.hash,
    tree.calls.hash,
  ]);
}
function hashCons(forestHash: Field, nodeHash: Field) {
  return Poseidon.hashWithPrefix(prefixes.accountUpdateCons, [
    nodeHash,
    forestHash,
  ]);
}

function hashAccountUpdate(update: AccountUpdate) {
  return genericHash(AccountUpdate, prefixes.body, update);
}

/**
 * Structure for constructing a call forest from a circuit.
 *
 * The circuit can mutate account updates and change their array of children, so here we can't hash
 * everything immediately. Instead, we maintain a structure consisting of either hashes or full account
 * updates that can be hashed into a final call forest at the end.
 */
type CallForestUnderConstruction = HashOrValue<
  {
    accountUpdate: HashOrValue<AccountUpdate>;
    calls: CallForestUnderConstruction;
  }[]
>;

type HashOrValue<T> =
  | { useHash: true; hash: Field; value: T }
  | { useHash: false; value: T };

const CallForestUnderConstruction = {
  empty(): CallForestUnderConstruction {
    return { useHash: false, value: [] };
  },

  setHash(forest: CallForestUnderConstruction, hash: Field) {
    Object.assign(forest, { useHash: true, hash });
  },

  witnessHash(forest: CallForestUnderConstruction) {
    let hash = Provable.witness(Field, () => {
      let nodes = forest.value.map(toCallTree);
      return withHashes(nodes, merkleListHash).hash;
    });
    CallForestUnderConstruction.setHash(forest, hash);
  },

  push(
    forest: CallForestUnderConstruction,
    accountUpdate: HashOrValue<AccountUpdate>,
    calls?: CallForestUnderConstruction
  ) {
    forest.value.push({
      accountUpdate,
      calls: calls ?? CallForestUnderConstruction.empty(),
    });
  },

  remove(forest: CallForestUnderConstruction, accountUpdate: AccountUpdate) {
    // find account update by .id
    let index = forest.value.findIndex(
      (node) => node.accountUpdate.value.id === accountUpdate.id
    );

    // nothing to do if it's not there
    if (index === -1) return;

    // remove it
    forest.value.splice(index, 1);
  },

  finalize(forest: CallForestUnderConstruction): CallForest {
    if (forest.useHash) {
      let data = Unconstrained.witness(() => {
        let nodes = forest.value.map(toCallTree);
        return withHashes(nodes, merkleListHash).data;
      });
      return new CallForest({ hash: forest.hash, data });
    }

    // not using the hash means we calculate it in-circuit
    let nodes = forest.value.map(toCallTree);
    return CallForest.from(nodes);
  },
};

function toCallTree(node: {
  accountUpdate: HashOrValue<AccountUpdate>;
  calls: CallForestUnderConstruction;
}): CallTree {
  let accountUpdate = node.accountUpdate.useHash
    ? new HashedAccountUpdate(
        node.accountUpdate.hash,
        Unconstrained.from(node.accountUpdate.value)
      )
    : HashedAccountUpdate.hash(node.accountUpdate.value);

  return {
    accountUpdate,
    calls: CallForestUnderConstruction.finalize(node.calls),
  };
}
