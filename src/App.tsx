import React, { useRef } from "react";
import { Device } from "./driver/rsc380";

export const App = () => {
  const rsc380 = useRef<Device>(new Device());

  const connectRsc380 = async () => {
    try {
      await rsc380.current.connect();
    } catch (error) {
      console.error(error);
    }
  };

  // const disconnectRsc380 = async () => {
  //   await rsc380.current.disconnect();
  // };

  const getFirmwareVersion = async () => {
    try {
      await rsc380.current.getFirmwareVersion();
    } catch (error) {
      console.error(error);
    }
  };

  const sendCmdRecvRsp = async () => {
    try {
      await rsc380.current.senseForTypeA();
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <div>
      <button onClick={connectRsc380}>Connect NFC reader</button>
      <button onClick={getFirmwareVersion}>Get Firmware Version</button>
      <button onClick={sendCmdRecvRsp}>Send CMD</button>
    </div>
  );
};
