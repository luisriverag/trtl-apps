import axios from 'axios';
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
import { ServiceWallet, WalletInfo, ServiceConfig, WalletInfoUpdate, WalletSyncInfo,
  StartWalletRequest, PrepareTransactionRequest } from './types';
import { SubWalletInfo, WalletStatus } from '../../shared/types';
import { SendTransactionResult } from 'turtlecoin-wallet-backend/dist/lib/Types';
import { google } from 'googleapis';
import { Storage } from '@google-cloud/storage';

let masterWallet: WalletBackend | undefined;
let masterWalletStartedAt: number | undefined;
let masterWalletLastSaveAt: number | undefined;

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
    await masterWallet.start();

    // give the new wallet time to sync
    await sleep(20 * 1000);

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
    // stoping current wallet instance
    if (masterWallet) {
      await masterWallet.stop();
      masterWallet.removeAllListeners();
      masterWallet = undefined;
    }

    return [undefined, new ServiceError('service/master-wallet-sync-failed')];
  }

  return [serviceWallet, undefined];
}

export async function getMasterWallet(
  serviceConfig: ServiceConfig,
  forceRestart = false,
  rewindDistanceOnStart = 40): Promise<[WalletBackend | undefined, undefined | ServiceError]> {

  const walletInfo = await getMasterWalletInfo();

  if(!walletInfo) {
    return [undefined, new ServiceError('service/master-wallet-info')];
  }

  if (masterWallet) {

    const daemonInfo = masterWallet.getDaemonConnectionInfo();
    let restartNeeded = false;

    if (daemonInfo.host !== serviceConfig.daemonHost || daemonInfo.port !== serviceConfig.daemonPort) {
      console.log('daemon info changed, restart needed.');
      restartNeeded = true;
    }

    if (masterWalletStartedAt && Date.now() >= (masterWalletStartedAt + (1000 * 60 * 10))) {
      // 10 minutes is the max lifetime of a master wallet instance
      console.log('max wallet instance time exceeded, restart needed.');
      restartNeeded = true;
    }

    if (masterWalletLastSaveAt !== walletInfo.lastSaveAt)
    {
      console.log('wallet saved since last start, restart needed.');
      restartNeeded = true;
    }

    if (restartNeeded || forceRestart) {
      console.log(`starting new wallet instance...`);

      // load and swap to a new instance of the master wallet
      const encryptedString = await getMasterWalletString();

      if (!encryptedString) {
        return [undefined, new ServiceError('service/master-wallet-file')];
      }

      const [newWallet, error] = await startWalletFromString(encryptedString, serviceConfig.daemonHost, serviceConfig.daemonPort);

      if (!newWallet) {
        return [undefined, error];
      }

      if (rewindDistanceOnStart > 0) {
        await rewindWallet(newWallet, rewindDistanceOnStart);
      }

      const oldWalletInstance = masterWallet;

      masterWallet = newWallet;
      masterWalletLastSaveAt = walletInfo.lastSaveAt;
      console.log(`new master wallet instance started at: ${masterWalletStartedAt}`);

      await oldWalletInstance.stop();
      oldWalletInstance.removeAllListeners();

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
      console.log(`new master wallet instance started at: ${masterWalletStartedAt}`);

      if (rewindDistanceOnStart > 0) {
        await rewindWallet(wallet, rewindDistanceOnStart);
      }

      masterWallet = wallet;
      masterWalletLastSaveAt = walletInfo.lastSaveAt;
    }

    return [wallet, error];
  }
}

export async function prepareAccountTransaction(
  serviceConfig: ServiceConfig,
  appWallet: string,
  accountId: string,
  sendAddress: string,
  paymentId: string,
  amount: number): Promise<[SendTransactionResult | undefined, undefined | ServiceError]> {

  const [token, jwtError] = await getAppEngineToken();

  if (!token) {
    console.log(`wallet jwt token error: ${(jwtError as ServiceError).message}`);
    return [undefined, jwtError];
  }

  const walletReady = await warmupAppEngineWallet(token, serviceConfig);

  console.log(`wallet ready? ${walletReady}`);

  if (!walletReady) {
    return [undefined, new ServiceError('service/unknown-error', 'cloud wallet not ready.')];
  }

  const txRequest: PrepareTransactionRequest = {
    subWallet: appWallet,
    senderId: accountId,
    sendAddress: sendAddress,
    amount: amount,
    paymentId: paymentId
  }

  const cloudWalletApi = getCloudWalletApiBase();
  const endpoint = `${cloudWalletApi}/prepare_transaction`;

  const reqConfig = {
    headers: { Authorization: "Bearer " + token }
  }

  try {
    const response = await axios.post(endpoint, txRequest, reqConfig);
    const sendResult = response.data as SendTransactionResult;

    console.log(sendResult);
    return [sendResult, undefined];
  } catch (error) {
    return [undefined, error.response.data];
  }
}

export async function sendPreparedTransaction(
  preparedTxHash: string,
  serviceConfig: ServiceConfig): Promise<[SendTransactionResult | undefined, undefined | ServiceError]> {

  const [token, jwtError] = await getAppEngineToken();

  if (!token) {
    console.log(`wallet jwt token error: ${(jwtError as ServiceError).message}`);
    return [undefined, jwtError];
  }

  const walletReady = await warmupAppEngineWallet(token, serviceConfig);

  if (!walletReady) {
    return [undefined, new ServiceError('service/unknown-error', 'cloud wallet not ready.')];
  }

  const body: any = {
    preparedTxHash: preparedTxHash
  }

  const cloudWalletApi = getCloudWalletApiBase();
  const endpoint = `${cloudWalletApi}/send`;

  const reqConfig = {
    headers: { Authorization: "Bearer " + token }
  }

  try {
    const response = await axios.post(endpoint, body, reqConfig);
    const sendResult = response.data as SendTransactionResult;

    return [sendResult, undefined];
  } catch (error) {
    return [undefined, new ServiceError('service/unknown-error', error.response.data)];
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
  const syncInfoStart = getWalletSyncInfo(wallet);

  console.log(`wait for sync => sync info at start: ${JSON.stringify(syncInfoStart)}`);

  if (syncInfoStart.heightDelta <= 2) {
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

  const p2 = sleep(timeout).then(async (_) => {
    const syncInfoAfterWait = getWalletSyncInfo(wallet);
    const synced            = syncInfoAfterWait.heightDelta <= 2;
    const blocksProcessed   = syncInfoAfterWait.walletHeight - syncInfoStart.walletHeight;

    console.log(`wait for sync => height delta after max wait time: ${JSON.stringify(syncInfoAfterWait)}`);
    console.log(`blocks processed while waiting: ${blocksProcessed}`);

    if (!synced) {
      if (blocksProcessed < 2) {
        const currentNode = wallet.getDaemonConnectionInfo().host;
        console.log(`current node ${currentNode} not processing blocks, calling drop node...`);

        await ServiceModule.dropCurrentNode(currentNode);
      }
    }

    return Promise.resolve(synced);
  });

  return Promise.race([p1, p2]);
}

export async function saveMasterWallet(wallet: WalletBackend): Promise<[number | undefined, undefined | ServiceError]> {
  const masterWalletInfo = await getMasterWalletInfo();

  if (!masterWalletInfo) {
    return [undefined, new ServiceError('service/master-wallet-info')];
  }

  const encryptedString = wallet.encryptWalletToString(functions.config().serviceadmin.password);
  const timestamp       = Date.now();

  const saveResults = await Promise.all([
    saveWalletFirebase(masterWalletInfo.location, encryptedString),
    saveWalletAppEngine(encryptedString)
  ]);

  console.log(`save wallet firebase succeeded? ${saveResults[0]}`);
  console.log(`save wallet appEngine succeeded? ${saveResults[1]}`);

  if (saveResults[0]) {
    const updateObject: WalletInfoUpdate = {
      lastSaveAt: Date.now()
    }

    await admin.firestore().doc('wallets/master').update(updateObject);
  }

  return [timestamp, undefined];
}

async function saveWalletFirebase(filepath: string, encryptedWallet: string): Promise<boolean> {
  try {
    const bucket = admin.storage().bucket();
    const file = bucket.file(filepath);

    await file.save(encryptedWallet);
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

async function saveWalletAppEngine(encryptedWallet: string): Promise<boolean> {
  try {
    const bucket      = admin.storage().bucket();
    const keyFile     = bucket.file(Constants.gcpServiceAccountFilename);
    const buffer      = await keyFile.download();
    const keyJson     = buffer.toString();
    const keyFilePath = path.join(os.tmpdir(), 'keyfile.json');

    fs.writeFileSync(keyFilePath, keyJson);

    const gcp_storage = new Storage({
      keyFilename: keyFilePath,
      projectId: functions.config().cloudwallet.project_id
    });

    const gcpBucket = gcp_storage.bucket(functions.config().cloudwallet.wallets_bucket);
    const file      = gcpBucket.file(Constants.gcpWalletFilename);

    await file.save(encryptedWallet);

    // delete temp files
    fs.unlinkSync(keyFilePath);

    return true;
  } catch (error) {
    console.error(error);
    return false;
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

export function getWalletSyncInfo(wallet: WalletBackend): WalletSyncInfo {
  const [walletHeight,, networkHeight] = wallet.getSyncStatus();
  const delta = networkHeight - walletHeight;

  return {
    walletHeight: walletHeight,
    networkHeight: networkHeight,
    heightDelta: delta
  };
}

export async function getCloudWalletStatus(jwtToken: string): Promise<WalletStatus | undefined> {
  const cloudWalletApi = getCloudWalletApiBase();
  const statusEndpoint = `${cloudWalletApi}/status`;

  const reqConfig = {
    headers: { Authorization: "Bearer " + jwtToken }
  }

  try {
    const statusResponse = await axios.get(statusEndpoint, reqConfig);
    return statusResponse.data as WalletStatus;
  } catch (error) {
    console.log(error);

    return undefined;
  }
}

export async function rewindAppEngineWallet(
  distance: number,
  serviceConfig: ServiceConfig): Promise<[number | undefined, undefined | ServiceError]> {

  const [token, jwtError] = await getAppEngineToken();

  if (!token) {
    console.log(`wallet jwt token error: ${(jwtError as ServiceError).message}`);
    return [undefined, jwtError];
  }

  const cloudWalletApi = getCloudWalletApiBase();

  const reqConfig = {
    headers: { Authorization: "Bearer " + token }
  }

  const walletStarted = await warmupAppEngineWallet(token, serviceConfig);

  if (!walletStarted) {
    return [undefined, new ServiceError('service/unknown-error', 'failed to warmup app engine wallet.')]
  }

  const rewindEndpoint = `${cloudWalletApi}/rewind`;

  console.log(`rewinding App Engine wallet by distance: ${distance}`);

  try {
    const reqBody = { distance: distance }
    const rewindResponse = await axios.post(rewindEndpoint, reqBody, reqConfig);
    const walletHeight: number = rewindResponse.data.walletHeight;

    return [walletHeight, undefined];
  } catch (error) {
    return [undefined, new ServiceError('service/unknown-error', error)];
  }
}

export async function warmupAppEngineWallet(jwtToken: string, serviceConfig: ServiceConfig): Promise<boolean> {
  const status = await getCloudWalletStatus(jwtToken);

  if (!status) {
    return false;
  }

  const maxUptime = 1000 * 60 * 60 * 4 // 4 hours
  let restartRequired = false;

  if (!status.started) {
    restartRequired = true;
  } else {
    if (status.daemonHost !== serviceConfig.daemonHost) {
      restartRequired = true;
    }
    if (status.uptime && status.uptime > maxUptime) {
      restartRequired = true;
    }
  }

  if (!restartRequired) {
    return true;
  }


  return await startAppEngineWallet(jwtToken, serviceConfig);
}

export async function startAppEngineWallet(jwtToken: string, serviceConfig: ServiceConfig): Promise<boolean> {
  console.log(`starting up coud wallet...`);
  const cloudWalletApi = getCloudWalletApiBase();

  const reqConfig = {
    headers: { Authorization: "Bearer " + jwtToken }
  }

  const startEndpoint = `${cloudWalletApi}/start`;

  const startBody: StartWalletRequest = {
    daemonHost: serviceConfig.daemonHost,
    daemonPort: serviceConfig.daemonPort
  }

  try {
    const startResponse = await axios.post(startEndpoint, startBody, reqConfig);
    const walletStatus: WalletStatus = startResponse.data;

    return walletStatus.started;
  } catch (error) {
    return false;
  }
}

export async function getAppEngineToken(): Promise<[string | undefined, undefined | ServiceError]> {
  const client_email    = functions.config().cloudwallet.client_email;
  const target_audience = functions.config().cloudwallet.target_audience;
  const private_key_raw = functions.config().cloudwallet.private_key;
  const private_key     = private_key_raw.replace(new RegExp("\\\\n", "\g"), "\n");

  // configure a JWT auth client
  const jwtClient = new google.auth.JWT(
    client_email,
    undefined,
    private_key);

  jwtClient.additionalClaims = {
    target_audience: target_audience
  }

  try {
    const response = await jwtClient.authorize();

    if (response.id_token) {
      return [response.id_token, undefined];
    } else {
      return [undefined, new ServiceError('service/unknown-error')];
    }
  } catch (error) {
    return [undefined, new ServiceError('service/unknown-error', error)];
  }
}

function getCloudWalletApiBase(): string {
  return functions.config().cloudwallet.api_base;
}

async function rewindWallet(wallet: WalletBackend, distance :number): Promise<void> {
  const [wHeight] = wallet.getSyncStatus();
  const rewindHeight = wHeight - distance;

  await wallet.rewind(rewindHeight);
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

    masterWalletStartedAt = Date.now();
    return [wallet, undefined];
  }
}

async function getMasterWalletString(): Promise<string | null> {
  const masterWalletInfo = await getMasterWalletInfo();

  if (!masterWalletInfo) {
    return null;
  }

  try {
    const bucket = admin.storage().bucket();
    const f = bucket.file(masterWalletInfo.location);

    const buffer = await f.download();
    return buffer.toString();
  } catch (error) {
    console.error(`failed to read wallet file: ${error.message}`);
    return null;
  }
}
