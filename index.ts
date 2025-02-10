import * as LZString from "lz-string";
import * as CryptoJS from "crypto-js";
export const cryptoJS = CryptoJS;
export const lZString = LZString;
// SDK 初始化选项的接口
interface OfflineSyncSDKOptions {
  dbName?: string;
  // storeName?: string;
  storeNames?:{[key:string]:string}
  syncUrl: string;
  maxRetries?: number;
  retryDelay?: number;
  batchSize?: number;
  encryptionKey?: string;
}

// 离线数据结构的接口
interface OfflineData {
  id?: number;
  priority?: number;
  retryCount?: number;
  [key: string]: any;
}

export class OfflineSyncSDK {
  private dbName: string;
  // private storeName: string;
  storeNames?:{[key:string]:string}
  private syncUrl: string;
  private db: IDBDatabase | null;
  private isOnline: boolean;
  private maxRetries: number;
  private retryDelay: number;
  private batchSize: number;
  private encryptionKey: string | null;

  /**
   * OfflineSyncSDK 的构造函数
   * @param options SDK 的配置选项
   */
  constructor(options: OfflineSyncSDKOptions) {
    this.dbName = options.dbName || "OfflineSyncDB";
    // this.storeName = options.storeName || "offlineData";
    this.storeNames = options.storeNames || { default: "offlineData" };
    this.syncUrl = options.syncUrl;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 5000;
    this.batchSize = options.batchSize || 10;
    this.encryptionKey = options.encryptionKey || null;
    this.db = null;
    this.isOnline = navigator.onLine;
    this.initDB();
    this.initNetworkListeners();
  }

  /**
   * 初始化 IndexedDB 数据库
   * @returns 一个在数据库初始化完成时解析的 Promise
   */
  private async initDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request: IDBOpenDBRequest = indexedDB.open(this.dbName, 1);

      request.onerror = (event: Event) => {
        console.error(
          "IndexedDB 错误:",
          (event.target as IDBOpenDBRequest).error
        );
        reject((event.target as IDBOpenDBRequest).error);
      };

      request.onsuccess = (event: Event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        console.log("IndexedDB 初始化成功");
        resolve();
      };

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db: IDBDatabase = (event.target as IDBOpenDBRequest).result;
        // db.createObjectStore(this.storeName, {
        //   keyPath: "id",
        //   autoIncrement: true,
        // });
        Object.values(this.storeNames).forEach(storeName=>{
          db.createObjectStore(storeName, {
            keyPath: "id",
            autoIncrement: true,
          });
        })
      };
    });
  }

  /**
   * 初始化网络状态监听器
   */
  private initNetworkListeners(): void {
    window.addEventListener("online", () => {
      this.isOnline = true;
      this.syncData();
    });

    window.addEventListener("offline", () => {
      this.isOnline = false;
    });
  }

  /**
   * 存储数据，如果在线则直接发送，否则保存到 IndexedDB
   * @param data 要存储的数据
   * @returns 一个解析为操作结果的 Promise
   */


 public async storeData(data: OfflineData, storeName?: string): Promise<number | Response> {
  const targetStore = storeName ? this.storeNames[storeName] : Object.values(this.storeNames)[0];
  if (!targetStore) {
    throw new Error(`Store ${storeName} not found`);
  }

  if (this.isOnline) {
    return this.sendData(data);
  } else {
    data.priority = data.priority || 0;
    data.retryCount = 0;
    const compressedData = this.compressData(data);
    const encryptedData = this.encryptData(compressedData);
    const offlineDataToStore: OfflineData = {
      ...data,
      encryptedContent: encryptedData
    };
    return this.addToIndexedDB(offlineDataToStore, targetStore);
  }
}


  /**
   * 将 IndexedDB 中的数据同步到服务器
   */
  private async syncData(storeName?:string): Promise<void> {
    if (!this.isOnline || !this.db) return;
    const target = storeName? this.storeNames[storeName] : Object.values(this.storeNames)[0];
    const transaction: IDBTransaction = this.db.transaction(
      [target],
      "readwrite"
    );
    const store: IDBObjectStore = transaction.objectStore(target);
    const request: IDBRequest<OfflineData[]> = store.getAll();

    request.onsuccess = async (event: Event) => {
      const offlineData: OfflineData[] = (
        event.target as IDBRequest<OfflineData[]>
      ).result;
      // 按优先级排序（高优先级在前）
      offlineData.sort((a, b) => (b.priority || 0) - (a.priority || 0));

      // 批量同步
      for (let i = 0; i < offlineData.length; i += this.batchSize) {
        const batch = offlineData.slice(i, i + this.batchSize);
        await this.syncBatch(batch,storeName);
      }
    };

    request.onerror = (event: Event) => {
      console.error("获取同步数据时出错:", (event.target as IDBRequest).error);
    };
  }

  /**
   * 同步一批数据到服务器
   * @param batch 要同步的 OfflineData 数组
   */
  private async syncBatch(batch: OfflineData[],storeName:string): Promise<void> {
    const batchData = batch.map((item) => {
      const decryptedData = this.decryptData(item.encryptedContent);
      return this.decompressData(decryptedData);
    });
    try {
      const response = await this.sendBatchData(batchData);
      if (response.ok) {
        for (const item of batch) {
          if (item.id !== undefined) {
            await this.deleteData(item.id);
          }
        }
      } else {
        throw new Error("批量同步失败");
      }
    } catch (error) {
      console.error("同步批次时出错:", error);
      for (const item of batch) {
        await this.retryItem(item,storeName);
      }
    }
  }

  /**
   * 重试同步单个项目
   * @param item 要重试的 OfflineData 项
   */
  private async retryItem(item: OfflineData,storeName:string): Promise<void> {
    if ((item.retryCount || 0) < this.maxRetries) {
      item.retryCount = (item.retryCount || 0) + 1;
      const targetStore = storeName ? this.storeNames[storeName] : Object.values(this.storeNames)[0];
      await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
      await this.addToIndexedDB(item,targetStore);
    } else {
      console.error("项目达到最大重试次数:", item);
    }
  }

  /**
   * 发送一批数据到服务器
   * @param data 要发送的 OfflineData 数组
   * @returns 一个解析为服务器响应的 Promise
   */
  private async sendBatchData(data: OfflineData[]): Promise<Response> {
    const response = await fetch(this.syncUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error("网络响应不正常");
    }

    return response;
  }

  /**
   * 发送单个数据项到服务器
   * @param data 要发送的 OfflineData
   * @returns 一个解析为服务器响应的 Promise
   */
  private async sendData(data: OfflineData): Promise<Response> {
    const response = await fetch(this.syncUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error("网络响应不正常");
    }

    return response;
  }

  /**
   * 使用 LZ-string 压缩数据
   * @param data 要压缩的数据
   * @returns 压缩后的数据字符串
   */
  private compressData(data: OfflineData): string {
    return LZString.compress(JSON.stringify(data));
  }

  /**
   * 使用 LZ-string 解压数据
   * @param compressedData 压缩的数据字符串
   * @returns 解压后的 OfflineData 对象
   */
  private decompressData(compressedData: string): OfflineData {
    return JSON.parse(LZString.decompress(compressedData));
  }

  /**
   * 使用 AES 加密数据
   * @param data 要加密的数据
   * @returns 加密后的数据字符串
   */
  private encryptData(data: string): string {
    if (!this.encryptionKey) return data;
    return CryptoJS.AES.encrypt(data, this.encryptionKey).toString();
  }
  /**
   * 使用 AES 解密数据
   * @param data 要解密的数据
   * @returns 解密后的数据字符串
   */
  private decryptData(data: string): string {
    if (!this.encryptionKey) return data;
    const decrypted = CryptoJS.AES.decrypt(data, this.encryptionKey);
    return decrypted.toString(CryptoJS.enc.Utf8);
  }
  /**
   * 将数据添加到 IndexedDB
   * @param data 要添加到 IndexedDB 的 OfflineData
   * @returns 一个解析为添加项 ID 的 Promise
   */


private async addToIndexedDB(data: OfflineData, storeName: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    if (!this.db) {
      reject(new Error("数据库未初始化"));
      return;
    }
    const transaction: IDBTransaction = this.db.transaction(
      [storeName],
      "readwrite"
    );
    const store: IDBObjectStore = transaction.objectStore(storeName);
    const request: IDBRequest<IDBValidKey> = store.add(data);

    request.onerror = (event: Event) => {
      console.error("存储数据时出错:", (event.target as IDBRequest).error);
      reject((event.target as IDBRequest).error);
    };

    request.onsuccess = (event: Event) => {
      console.log("数据存储成功");
      resolve((event.target as IDBRequest<number>).result);
    };
  });
}
  /**
   * 从 IndexedDB 删除数据
   * @param id 要删除的项目的 ID
   * @returns 一个在项目删除时解析的 Promise
   */

  private async deleteData(id: number,storeName?:string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.db) {
        reject(new Error("数据库未初始化"));
        return;
      }
      const targetStore = storeName  ? this.storeNames[storeName]: Object.values(this.storeNames)[0];
      if (!targetStore) {
        reject(new Error(`Store ${storeName} not found`));
        return;
      }
      const transaction: IDBTransaction = this.db.transaction(
        [targetStore],
        "readwrite"
      );
      const store: IDBObjectStore = transaction.objectStore(targetStore);
      const request: IDBRequest = store.delete(id);

      request.onerror = (event: Event) => {
        console.error("删除数据时出错:", (event.target as IDBRequest).error);
        reject((event.target as IDBRequest).error);
      };

      request.onsuccess = () => {
        console.log("数据删除成功");
        resolve();
      };
    });
  }
}
