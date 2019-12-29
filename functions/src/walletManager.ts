import * as functions from 'firebase-functions';
import * as ServiceModule from './serviceModule';
import * as Constants from './constants';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WalletBackend, IDaemon, Daemon, WalletError } from 'turtlecoin-wallet-backend';
import { sleep } from './utils';
import { ServiceError } from './serviceError';
import { ServiceWallet, WalletInfo, ServiceConfig, WalletInfoUpdate } from './types';
import { SubWalletInfo } from '../../shared/types';

let masterWallet: WalletBackend | undefined;
let masterWalletStartedAt: number | undefined;

export async function createMasterWallet(serviceConfig: ServiceConfig): Promise<[string | undefined, undefined | ServiceError]> {
  console.log('creating new master wallet...');
  const walletDoc: WalletInfo = {
    location:         Constants.defaultWalletLocation,
    backupsDirectory: Constants.defaultWalletBackupsDirectory,
    lastSaveAt:       Date.now(),
    lastBackupAt:     0
  }

  try {
    await admin.firestore().doc('wallets/master').create(walletDoc);
    console.log(`master wallet info doc successfully created...`);
  } catch (error) {
    console.error(error);
    return [undefined, new ServiceError('service/master-wallet-info', `Error creating WalletInfo: ${error}`)];
  }

  const daemon: IDaemon = new Daemon(serviceConfig.daemonHost, serviceConfig.daemonPort);

  try {
    masterWallet = WalletBackend.createWallet(daemon);
    console.log(`successfully created new WalletBackend!`);
  } catch (error) {
    console.error(`error creating new WalletBackend: ${error}`);
    return [undefined, new ServiceError('service/unknown-error', error)];
  }

  const [saveDate, saveError] = await saveMasterWallet(masterWallet);

  if (!saveDate) {
    console.error('error saving master wallet!');
    return [undefined, saveError];
  }

  const [seed, seedError] = masterWallet.getMnemonicSeed();

  if (!seed) {
    return [undefined, new ServiceError('service/master-wallet-info', (seedError as WalletError).toString())];
  }

  return [seed, undefined];
}

export async function getServiceWallet(
  waitForSync: boolean = true): Promise<[ServiceWallet | undefined, undefined | ServiceError]> {

  const [serviceConfig, configError] = await ServiceModule.getServiceConfig();

  if (!serviceConfig) {
    return [undefined, configError];
  }

  if (serviceConfig.serviceHalted) {
    return [undefined, new ServiceError('service/service-halted')];
  }

  const [wallet, openError] = await getMasterWallet(serviceConfig);

  if (!wallet) {
    return [undefined, openError];
  }

  const serviceWallet: ServiceWallet = {
    wallet: wallet,
    serviceConfig: serviceConfig
  }

  if (!waitForSync) {
    return [serviceWallet, undefined];
  }

  const syncStart     = Date.now();
  const synced        = await waitForWalletSync(wallet, serviceConfig.waitForSyncTimeout);
  const syncEnd       = Date.now();
  const syncSeconds   = (syncEnd - syncStart) / 1000;

  console.log(`sync successful? [${synced}], sync time: ${syncSeconds}(s)`);

  if (!synced) {
    return [undefined, new ServiceError('service/master-wallet-sync-failed')];
  }

  return [serviceWallet, undefined];
}

export async function getMasterWallet(serviceConfig: ServiceConfig): Promise<[WalletBackend | undefined, undefined | ServiceError]> {
  if (masterWallet) {
    const daemonInfo = masterWallet.getDaemonConnectionInfo();
    let restartNeeded = false;

    if (daemonInfo.host !== serviceConfig.daemonHost || daemonInfo.port !== serviceConfig.daemonPort) {
      restartNeeded = true;
    }

    if (masterWalletStartedAt && Date.now() >= (masterWalletStartedAt + (1000 * 60 * 10))) {
      // 10 minutes is the max lifetime of a master wallet instance
      restartNeeded = true;
    }

    if (restartNeeded) {
      console.log(`master wallet restart needed, swapping to new instance...`);

      // load and swap to a new instance of the master wallet
      const encryptedString = await getMasterWalletString();

      if (!encryptedString) {
        return [undefined, new ServiceError('service/master-wallet-file')];
      }

      const [newWallet, error] = await startWalletFromString(encryptedString, serviceConfig.daemonHost, serviceConfig.daemonPort);

      if (!newWallet) {
        return [undefined, error];
      }

      // swap instances
      const oldWallet = masterWallet;
      masterWallet = newWallet;
      masterWalletStartedAt = Date.now();
      console.log(`new master wallet instance started at: ${masterWalletStartedAt}`);

      // kill old instance
      await oldWallet.stop();

      return [masterWallet, undefined];
    } else {
      return [masterWallet, undefined];
    }

  } else {
    const encryptedString = await getMasterWalletString();

    if (!encryptedString) {
      console.error('no master wallet file data.');
      return [undefined, new ServiceError('service/master-wallet-file')];
    }

    const [wallet, error] = await startWalletFromString(encryptedString, serviceConfig.daemonHost, serviceConfig.daemonPort);

    if (wallet) {
      masterWallet = wallet;
      masterWalletStartedAt = Date.now();
      console.log(`new master wallet instance started at: ${masterWalletStartedAt}`);
    }

    return [wallet, error];
  }
}

 /**
 * Get the unlocked and locked balance for the subWallet address.
 * If the function failed, success will be false. if it succeeded the balances are returned
 *
 * Example:
 * ```javascript
 * const [success, unlockedBalance, lockedBalance] = getSubWalletBalance(subWalletAddress);
 * ```
 *
 * @param subWalletAddress The subWallet address to check the balance of.
 */
export async function getSubWalletBalance(subWalletAddress: string): Promise<[boolean, number, number]> {
  const [serviceWallet, error] = await getServiceWallet();

  if (error || !serviceWallet) {
    console.error(`failed to get service wallet: ${(error as ServiceError).message}`);
    return [false, 0, 0];
  }

  const [unlockedBalance, lockedBalance] = serviceWallet.wallet.getBalance([subWalletAddress]);
  return [true, unlockedBalance, lockedBalance];
}

export async function waitForWalletSync(wallet: WalletBackend, timeout: number): Promise<boolean> {
  const [wHeight,, nHeight] = wallet.getSyncStatus();

  if (wHeight >= nHeight) {
    // console.log(`wallet synced! Wallet height: ${wHeight}, Network height: ${nHeight}`);
    return Promise.resolve(true);
  }

  const p1 = new Promise<boolean>(function(resolve, reject) {
    let synced = false;
    wallet.on('sync', (walletHeight, networkHeight) => {
      if (!synced) {
        synced = true;
        console.log(`wallet synced! Wallet height: ${walletHeight}, Network height: ${networkHeight}`);
        resolve(true);
      }
    });
  });

  const p2 = sleep(timeout).then(_ => { return Promise.resolve(false); });

  return Promise.race([p1, p2]);
}

export async function saveMasterWallet(wallet: WalletBackend): Promise<[number | undefined, undefined | ServiceError]> {
  const masterWalletInfo = await getMasterWalletInfo();

  if (!masterWalletInfo) {
    return [undefined, new ServiceError('service/master-wallet-info')];
  }

  try {
    const encryptedString = wallet.encryptWalletToString(functions.config().serviceadmin.password);
    const tempFile        = path.join(os.tmpdir(), 'masterwallet.bin');
    const timestamp       = Date.now()

    fs.writeFileSync(tempFile, encryptedString);

    const bucket = admin.storage().bucket();
    const f = bucket.file(masterWalletInfo.location);

    await f.save(encryptedString);

    // delete temp files
    fs.unlinkSync(tempFile);

    const updateObject: WalletInfoUpdate = {
      lastSaveAt: timestamp
    }

    await admin.firestore().doc('wallets/master').update(updateObject);

    return [timestamp, undefined];
  } catch (error) {
    console.error(error);
    return [undefined, new ServiceError('service/unknown-error', error)];
  }
}

export async function backupMasterWallet(): Promise<void> {
  const [serviceWallet, walletError] = await getServiceWallet(false);

  if (!serviceWallet) {
    const walletErrorMessage = (walletError as ServiceError).message;
    console.log(`error getting service wallet while performing wallet backup: ${walletErrorMessage}`);
    return;
  }

  const masterWalletInfo = await getMasterWalletInfo();

  if (!masterWalletInfo) {
    console.log('error getting master wallet error.');
    return;
  }

  const timestamp = Date.now();
  const fileName  = `masterwallet_backup_${timestamp}.bin`;

  try {
    const encryptedString = serviceWallet.wallet.encryptWalletToString(functions.config().serviceadmin.password);
    const tempFile        = path.join(os.tmpdir(), fileName);

    fs.writeFileSync(tempFile, encryptedString);

    const bucket  = admin.storage().bucket();
    const file    = bucket.file(`${masterWalletInfo.backupsDirectory}/${fileName}`);

    await file.save(encryptedString);

    // delete temp files
    fs.unlinkSync(tempFile);

    const updateObject: WalletInfoUpdate = {
      lastBackupAt: timestamp
    }

    await admin.firestore().doc('wallets/master').update(updateObject);
  } catch (error) {
    console.error(error);
  }
}

export async function getMasterWalletInfo(): Promise<WalletInfo | undefined> {
  const snapshot = await admin.firestore().doc('wallets/master').get();

  if (snapshot.exists) {
    return snapshot.data() as WalletInfo;
  } else {
    return undefined;
  }
}

export async function getSubWalletInfos(onlyUnclaimed = false): Promise<SubWalletInfo[]> {
  let subWalletDocs: FirebaseFirestore.QuerySnapshot;

  if (onlyUnclaimed) {
    subWalletDocs = await admin.firestore()
                          .collection('wallets/master/subWallets')
                          .where('claimed', '==', false)
                          .get();
  } else {
    subWalletDocs = await admin.firestore().collection('wallets/master/subWallets').get();
  }

  return subWalletDocs.docs.map(d => d.data() as SubWalletInfo);
}

async function startWalletFromString(
  encryptedString: string,
  daemonHost: string,
  daemonPort: number): Promise<[WalletBackend | undefined, undefined | ServiceError]> {

  const daemon: IDaemon = new Daemon(daemonHost, daemonPort);

  daemon.updateConfig({
    customUserAgentString: Constants.walletBackendUserAgentId
  });

  const [wallet, error] = WalletBackend.openWalletFromEncryptedString(
                            daemon,
                            encryptedString,
                            functions.config().serviceadmin.password);

  if (error || !wallet) {
    console.error('failed to decrypt master wallet!');
    return [undefined, new ServiceError('service/master-wallet-file', 'Failed to decrypt wallet string')];
  } else {
    wallet.enableAutoOptimization(false);
    await wallet.start();

    return [wallet, undefined];
  }
}

async function getMasterWalletString(): Promise<string | null> {
  const masterWalletInfo = await getMasterWalletInfo();

  if (!masterWalletInfo) {
    return null;
  }

  const bucket = admin.storage().bucket();
  const f = bucket.file(masterWalletInfo.location);

  const buffer = await f.download();
  return buffer.toString();
}
