/* eslint-disable @typescript-eslint/no-explicit-any */
import { isEqual } from "lodash";
// Frame
class Frame {
  private _data: Uint8Array | null = null;
  private _type: string | null = null;
  private _frame: Uint8Array | null = null;

  constructor(data: Uint8Array) {
    if (isEqual(data.slice(0, 3), new Uint8Array([0x00, 0x00, 0xff]))) {
      const frame = new Uint8Array(data);

      if (
        isEqual(frame, new Uint8Array([0x00, 0x00, 0xff, 0x00, 0xff, 0x00]))
      ) {
        // ACK
        this._type = "ack";
      } else if (
        isEqual(frame, new Uint8Array([0x00, 0x00, 0xff, 0xff, 0xff]))
      ) {
        // ERROR
        this._type = "err";
      } else if (isEqual(frame.slice(3, 5), new Uint8Array([0xff, 0xff]))) {
        // DATA
        this._type = "data";
      }

      if (this._type === "data") {
        // FIXME: check
        const length = new DataView(frame.buffer).getUint16(5, true);
        this._data = frame.slice(8, 8 + length);
      }
    } else {
      let frame: number[] = [0, 0, 255, 255, 255];
      const length = new DataView(new ArrayBuffer(2));
      length.setUint16(0, data.length, true); // true for little-endian
      frame.push(length.getUint8(0), length.getUint8(1));

      // Calculate checksum for bytes at indices 5 and 6
      const checksum1 = (256 - ((frame[5] + frame[6]) % 256)) % 256;
      frame.push(checksum1);

      // Add data bytes
      frame = frame.concat(Array.from(data));

      // Calculate checksum for the frame starting from index 8
      const checksum2 =
        (256 - (frame.slice(8).reduce((sum, byte) => sum + byte, 0) % 256)) %
        256;
      frame.push(checksum2, 0);

      // Convert frame to Uint8Array and assign to this._frame
      this._frame = new Uint8Array(frame);
    }
  }

  toString(): string {
    return this._frame ? this._frame.toString() : "";
  }

  toBytes(): Uint8Array | null {
    return this._frame;
  }

  get type(): string | null {
    return this._type;
  }

  get data(): Uint8Array | null {
    return this._data;
  }
}

class CommunicationError extends Error {
  // Mapping error codes to their corresponding string representations
  static err2str: Record<number, string> = {
    0x00000000: "NO_ERROR",
    0x00000001: "PROTOCOL_ERROR",
    0x00000002: "PARITY_ERROR",
    0x00000004: "CRC_ERROR",
    0x00000008: "COLLISION_ERROR",
    0x00000010: "OVERFLOW_ERROR",
    0x00000040: "TEMPERATURE_ERROR",
    0x00000080: "RECEIVE_TIMEOUT_ERROR",
    0x00000100: "CRYPTO1_ERROR",
    0x00000200: "RFCA_ERROR",
    0x00000400: "RF_OFF_ERROR",
    0x00000800: "TRANSMIT_TIMEOUT_ERROR",
    0x80000000: "RECEIVE_LENGTH_ERROR",
  };

  // Reverse mapping from string representation to error code
  static str2err: Record<string, number> = Object.fromEntries(
    Object.entries(CommunicationError.err2str).map(([k, v]) => [v, parseInt(k)])
  );

  errno: number;

  constructor(statusBytes: Uint8Array) {
    super();
    // Interpret the status bytes as a 32-bit little-endian integer
    this.errno = new DataView(statusBytes.buffer).getUint32(0, true);
  }

  // Compare error code with a string representation of the error
  equals(strErr: string): boolean {
    const errno = CommunicationError.str2err[strErr];
    return (this.errno & errno) !== 0 || this.errno === errno;
  }

  notEquals(strErr: string): boolean {
    return !this.equals(strErr);
  }

  toString(): string {
    const errorString =
      CommunicationError.err2str[this.errno] ||
      `0x${this.errno.toString(16).padStart(8, "0")}`;
    return `${this.constructor.name} ${errorString}`;
  }
}

class StatusError extends Error {
  // Mapping error codes to string representations
  static err2str: string[] = [
    "SUCCESS",
    "PARAMETER_ERROR",
    "PB_ERROR",
    "RFCA_ERROR",
    "TEMPERATURE_ERROR",
    "PWD_ERROR",
    "RECEIVE_ERROR",
    "COMMANDTYPE_ERROR",
  ];

  errno: number;

  constructor(status: number) {
    super();
    this.errno = status;
  }

  toString(): string {
    if (this.errno < StatusError.err2str.length) {
      return StatusError.err2str[this.errno];
    } else {
      return `UNKNOWN STATUS ERROR 0x${this.errno
        .toString(16)
        .padStart(2, "0")}`;
    }
  }
}

class Chipset {
  static ACK: Uint8Array = new Uint8Array([0x00, 0x00, 0xff, 0x00, 0xff, 0x00]);

  static CMD: { [key: number]: string } = {
    0x00: "InSetRF",
    0x02: "InSetProtocol",
    0x04: "InCommRF",
    0x06: "SwitchRF",
    0x10: "MaintainFlash",
    0x12: "ResetDevice",
    0x20: "GetFirmwareVersion",
    0x22: "GetPDDataVersion",
    0x24: "GetProperty",
    0x26: "InGetProtocol",
    0x28: "GetCommandType",
    0x2a: "SetCommandType",
    0x30: "InSetRCT",
    0x32: "InGetRCT",
    0x34: "GetPDData",
    0x36: "ReadRegister",
    0x40: "TgSetRF",
    0x42: "TgSetProtocol",
    0x44: "TgSetAuto",
    0x46: "TgSetRFOff",
    0x48: "TgCommRF",
    0x50: "TgGetProtocol",
    0x60: "TgSetRCT",
    0x62: "TgGetRCT",
    0xf0: "Diagnose",
  };

  private transport: Transport | null;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  async init() {
    try {
      await this.transport?.write(Chipset.ACK);
      await this.setCommandType(0x01);
      // await this.switchRF("off");
    } catch (error) {
      console.log(error);
    }
  }

  close(): void {
    this.switchRF("off");
    this.transport?.write(Chipset.ACK);
    this.transport = null;
  }

  async sendCommand(
    cmdCode: number,
    cmdData: Uint8Array
  ): Promise<Uint8Array | void> {
    console.debug(`${Chipset.CMD[cmdCode]} ${this.hexlify(cmdData)}`);

    if (this.transport) {
      const cmd = new Uint8Array([0xd6, cmdCode, ...cmdData]);
      const cmdFrame = new Frame(cmd).toBytes();
      await this.transport.write(cmdFrame);
      // ACK
      const ackFrame = await this.transport.read();
      const ack = new Frame(ackFrame);

      if (ack.type === "ack") {
        const rspFrame = await this.transport.read();
        console.log({ rspFrame });
        const rsp = new Frame(rspFrame);
        if (
          rsp.type === "data" &&
          rsp.data?.[0] === 0xd7 &&
          rsp.data?.[1] === cmdCode + 1
        ) {
          return rsp.data?.slice(2);
        } else {
          console.error(
            `Expected response code D7${(cmdCode + 1)
              .toString(16)
              .padStart(2, "0")} not ${this.hexlify(rsp.data)}`
          );
        }
      } else {
        console.error(`Expected ack but got ${ack.type}`);
      }
    } else {
      console.debug("Transport closed in sendCommand");
    }
  }

  async inSetRF(brtySend: string, brtyRecv?: string) {
    const settings: { [key: string]: [number, number, number, number] } = {
      "212F": [1, 1, 15, 1],
      "424F": [1, 2, 15, 2],
      "106A": [2, 3, 15, 3],
      "212A": [4, 4, 15, 4],
      "424A": [5, 5, 15, 5],
      "106B": [3, 7, 15, 7],
      "212B": [3, 8, 15, 8],
      "424B": [3, 9, 15, 9],
    };

    // If brtyRecv is not provided, set it equal to brtySend
    if (!brtyRecv) {
      brtyRecv = brtySend;
    }

    // Combine the appropriate parts of the settings
    const data = new Uint8Array([
      ...settings[brtySend].slice(0, 2),
      ...settings[brtyRecv].slice(2, 4),
    ]);

    // Send command and handle response

    const responseData = await this.sendCommand(0x00, data);
    if (responseData && responseData[0] !== 0) {
      throw new StatusError(responseData[0]);
    }
  }

  async inSetProtocol(data?: Uint8Array, kwargs: Record<string, number> = {}) {
    data = data || new Uint8Array();

    const KEYS = [
      "initial_guard_time",
      "add_crc",
      "check_crc",
      "multi_card",
      "add_parity",
      "check_parity",
      "bitwise_anticoll",
      "last_byte_bit_count",
      "mifare_crypto",
      "add_sof",
      "check_sof",
      "add_eof",
      "check_eof",
      "rfu",
      "deaf_time",
      "continuous_receive_mode",
      "min_len_for_crm",
      "type_1_tag_rrdd",
      "rfca",
      "guard_time",
    ];

    for (const key of Object.keys(kwargs)) {
      const value = kwargs[key];
      const index = KEYS.indexOf(key);
      if (index >= 0) {
        data = Uint8Array.from([...data, index, value]);
      }
    }

    const responseData = await this.sendCommand(0x02, data);
    if (responseData && responseData[0] !== 0) {
      throw new StatusError(responseData[0]);
    }
  }

  async inCommRF(
    data: Uint8Array,
    timeout: number
  ): Promise<Uint8Array | void> {
    timeout = Math.min((timeout + (timeout > 0 ? 1 : 0)) * 10, 0xffff);
    const responseData = await this.sendCommand(
      0x04,
      new Uint8Array([...this.packTimeout(timeout), ...data])
    );

    if (responseData && !this.isZero(responseData.slice(0, 4))) {
      throw new CommunicationError(responseData.slice(0, 4));
    }

    return responseData?.slice(5);
  }

  async switchRF(state: "on" | "off") {
    const index = ["off", "on"].indexOf(state);
    const responseData = await this.sendCommand(0x06, new Uint8Array([index]));

    if (responseData && responseData[0] !== 0) {
      throw new StatusError(responseData[0]);
    }
  }

  private packTimeout(timeout: number): Uint8Array {
    const buffer = new ArrayBuffer(2);
    const view = new DataView(buffer);
    view.setUint16(0, timeout, true);
    return new Uint8Array(buffer);
  }

  private isZero(arr: Uint8Array): boolean {
    return arr.every((val) => val === 0);
  }

  private hexlify(data: Uint8Array | null): string {
    return Array.prototype.map
      .call(data ?? [], (byte: number) => ("00" + byte.toString(16)).slice(-2))
      .join("");
  }

  async getFirmwareVersion(option?: number): Promise<Uint8Array | void> {
    const data = await this.sendCommand(
      0x20,
      option ? new Uint8Array([option]) : new Uint8Array()
    );
    console.debug(
      `Firmware version ${data?.[1]?.toString(16)}.${data?.[0]
        ?.toString(16)
        .padStart(2, "0")}`
    );
    return data;
  }

  async getPDDataVersion(): Promise<Uint8Array | void> {
    const data = await this.sendCommand(0x22, new Uint8Array());
    console.debug(
      `Package data format ${data?.[1]?.toString(16)}.${data?.[0]
        ?.toString(16)
        .padStart(2, "0")}`
    );
    return data;
  }

  async setCommandType(commandType: number) {
    const data = await this.sendCommand(0x2a, new Uint8Array([commandType]));
    if (data && data[0] !== 0) {
      throw new StatusError(data[0]);
    }
  }
}

class Transport {
  MAX_RECEIVE_SIZE = 290;
  constructor(readonly device: USBDevice) {}

  async write(data: Uint8Array | null) {
    if (!data) return;
    await this.device.transferOut(2, data);
  }

  async read() {
    const result = await this.device.transferIn(1, this.MAX_RECEIVE_SIZE);
    // read 6 bytes first
    const frame =
      result.data !== undefined
        ? new Uint8Array(result.data.buffer)
        : new Uint8Array([
            0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0x00, 0x00, 0x00,
          ]);

    if (
      isEqual(
        frame.slice(0, 6),
        new Uint8Array([0x00, 0x00, 0xff, 0x00, 0xff, 0x00])
      )
    ) {
      // Error frame
      console.warn("transport frame error: ", frame);
      return frame;
    }

    return frame;
  }
}

export class Device {
  inSetProtocolDefaults: Uint8Array = new Uint8Array([
    0x00, 0x18, 0x01, 0x01, 0x02, 0x01, 0x03, 0x00, 0x04, 0x00, 0x05, 0x00,
    0x06, 0x00, 0x07, 0x08, 0x08, 0x00, 0x09, 0x00, 0x0a, 0x00, 0x0b, 0x00,
    0x0c, 0x00, 0x0e, 0x04, 0x0f, 0x00, 0x10, 0x00, 0x11, 0x00, 0x12, 0x00,
    0x13, 0x06,
  ]);

  private chipset: Chipset | null = null;
  constructor() {}

  async connect() {
    const filter: USBDeviceFilter = { vendorId: 0x054c, productId: 0x06c1 };
    const options: USBDeviceRequestOptions = { filters: [filter] };

    const device = await navigator.usb.requestDevice(options);
    await device.open();
    await device.selectConfiguration(1);
    await device.claimInterface(0);

    const transport = new Transport(device);
    this.chipset = new Chipset(transport);
    await this.chipset.init();
  }

  async sendCmdRecvRsp() {
    // pre-pair command
    this.chipset?.inSetRF("106A");
    this.chipset?.inSetProtocol(this.inSetProtocolDefaults);
    this.chipset?.inSetProtocol(
      new Uint8Array([
        0x00, 0x06, 0x01, 0x00, 0x02, 0x00, 0x05, 0x01, 0x07, 0x07,
      ])
    );
    while (true) {
      console.log("scan");
      await this.chipset?.sendCommand(
        0x04,
        new Uint8Array([0x6e, 0x00, 0x06, 0x00, 0xff, 0xff, 0x01, 0x00])
      );
    }
  }

  disconnect() {
    this.chipset?.close();
  }

  async getFirmwareVersion() {
    const rsp = await this.chipset?.sendCommand(0x20, new Uint8Array([]));
    console.log(
      `firmware version ${rsp?.[1].toString(16)}.${rsp?.[0]
        .toString(16)
        .padStart(2, "0")}`
    );
  }

  async senseForTypeA() {
    // await this.chipset?.inSetRF("106A");
    // await this.chipset?.inSetProtocol(this.inSetProtocolDefaults);
    // await this.chipset?.inSetProtocol(undefined, {
    //   initial_guard_time: 6,
    //   add_crc: 0,
    //   check_crc: 0,
    //   check_parity: 1,
    //   last_byte_bit_count: 7,
    // });

    await this.chipset?.inCommRF(
      new Uint8Array([0xff, 0xca, 0x00, 0x00, 0x00]),
      30
    );

    // try {
    //   const sensRsp = await this.chipset?.inCommRF(new Uint8Array([0x26]), 30);
    //   if (sensRsp?.length != 2) {
    //     return null;
    //   }
    //   // FIXME: check type 1
    //   if (sensRsp && (sensRsp[0] & 0x1f) == 0) {
    //     console.log("type 1 tag target found");
    //   }

    //   await this.chipset?.inSetProtocol(undefined, {
    //     last_byte_bit_count: 8,
    //     add_parity: 1,
    //   });

    //   //
    //   let uid = new Uint8Array();
    //   const commands = new Uint8Array([0x93, 0x95, 0x97]);

    //   for (const selCmd of commands) {
    //     console.log({ selCmd });
    //     await this.chipset?.inSetProtocol(undefined, {
    //       add_crc: 0,
    //       check_crc: 0,
    //     });
    //     const ssdReq = new Uint8Array([selCmd, 0x20]);
    //     console.log("ssdReq", ssdReq);
    //     const ssdRsp = await this.chipset?.inCommRF(ssdReq, 30);
    //     await this.chipset?.inSetProtocol(undefined, {
    //       add_crc: 1,
    //       check_crc: 1,
    //     });
    //     const selReq = new Uint8Array([selCmd, 0x70, ...(ssdRsp ?? [])]);
    //     const selRsp = await this.chipset?.inCommRF(selReq, 30);
    //     if (selRsp && selRsp[0] & 0b00000100) {
    //       uid = new Uint8Array(uid, ...(ssdRsp ?? []).slice(1, 4));
    //     } else {
    //       uid = new Uint8Array(uid, ...(ssdRsp ?? []).slice(0, 4));
    //     }
    //   }
    //   console.log({ uid });
    // } catch (error) {
    //   console.error("RECEIVE_TIMEOUT_ERROR", error);
    //   return null;
    // }
  }
}
