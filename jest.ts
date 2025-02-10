  import { OfflineSyncSDK } from './OfflineSyncSDK-chinese';
  // import {lZString,cryptoJS} from './OfflineSyncSDK-chinese';
 /*  
  1. SDK 的初始化
  2. 在线和离线状态下的数据存储
  3. 数据压缩和解压缩
  4. 数据加密和解密
  5. 批量同步功能
  6. 重试机制 
  */
  // 模拟 fetch API
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response)
  );

  // 模拟 IndexedDB
  const indexedDB = {
    open: jest.fn(),
  };
  global.indexedDB = indexedDB as any;

  describe('OfflineSyncSDK', () => {
    let sdk: OfflineSyncSDK;
    const mockOptions = {
      dbName: 'TestDB',
      storeName: 'TestStore',
      syncUrl: 'https://test.com/sync',
      maxRetries: 3,
      retryDelay: 1000,
      batchSize: 5,
      encryptionKey: 'testKey',
    };

    beforeEach(() => {
      // 重置所有的模拟函数
      jest.clearAllMocks();
      
      // 模拟 IndexedDB 的打开操作
      const mockDb = {
        createObjectStore: jest.fn(),
        transaction: jest.fn().mockReturnValue({
          objectStore: jest.fn().mockReturnValue({
            add: jest.fn(),
            delete: jest.fn(),
            getAll: jest.fn(),
          }),
        }),
      };
      indexedDB.open.mockImplementation(() => {
        const request = {} as IDBOpenDBRequest;
        setTimeout(() => {
          request.onsuccess && request.onsuccess({ target: { result: mockDb } } as unknown as Event);
        }, 0);
        return request;
      });

      sdk = new OfflineSyncSDK(mockOptions);
    });

    test('SDK 初始化', () => {
      expect(sdk).toBeDefined();
      expect(indexedDB.open).toHaveBeenCalledWith('TestDB', 1);
    });

    test('在线时存储数据', async () => {
      (sdk as any).isOnline = true;
      const testData = { id: 1, data: 'test' };
      await sdk.storeData(testData);
      expect(fetch).toHaveBeenCalledWith('https://test.com/sync', expect.any(Object));
    });

    test('离线时存储数据', async () => {
      (sdk as any).isOnline = false;
      const testData = { id: 1, data: 'test' };
      await sdk.storeData(testData);
      expect((sdk as any).addToIndexedDB).toHaveBeenCalled();
    });

    test('数据压缩', () => {
      const testData = { id: 1, data: 'test' };
      const compressed = (sdk as any).compressData(testData);
      const decompressed = (sdk as any).decompressData(compressed);
      expect(decompressed).toEqual(testData);
    });

    test('数据加密', () => {
      const testData = 'sensitive data';
      const encrypted = (sdk as any).encryptData(testData);
      const decrypted = (sdk as any).decryptData({ data: encrypted });
      expect(decrypted).toBe(JSON.stringify(testData));
    });

    test('批量同步', async () => {
      (sdk as any).isOnline = true;
      (sdk as any).db = {
        transaction: jest.fn().mockReturnValue({
          objectStore: jest.fn().mockReturnValue({
            getAll: jest.fn().mockReturnValue({
              onsuccess: jest.fn(),
            }),
          }),
        }),
      };

      await (sdk as any).syncData();
      expect((sdk as any).db.transaction).toHaveBeenCalled();
    });

    test('重试机制', async () => {
      const testItem = { id: 1, data: 'test', retryCount: 0 };
      await (sdk as any).retryItem(testItem);
      expect(testItem.retryCount).toBe(1);
    });
  });