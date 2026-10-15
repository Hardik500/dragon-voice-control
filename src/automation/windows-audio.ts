/**
 * PowerShell/Core Audio interop for Windows volume commands. Script generation
 * is pure so its COM layout and command values can be inspected on Linux.
 *
 * ABI source: Microsoft's Windows SDK headers in microsoft/win32metadata:
 * generation/WinSDK/RecompiledIdlHeaders/um/mmdeviceapi.h
 * generation/WinSDK/RecompiledIdlHeaders/um/endpointvolume.h
 * Interface declarations retain every native slot, in header order.
 */
const CORE_AUDIO_CS = `using System;
using System.Runtime.InteropServices;

namespace Dragon {
  public static class AudioEndpoint {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator {
      [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint stateMask, out IntPtr devices);
      [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
      [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice endpoint);
      [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
      [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice {
      [PreserveSig] int Activate([In] ref Guid iid, uint classContext, IntPtr activationParams,
        [MarshalAs(UnmanagedType.IUnknown)] out object instance);
      [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
      [PreserveSig] int GetId(out IntPtr id);
      [PreserveSig] int GetState(out uint state);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume {
      [PreserveSig] int RegisterControlChangeNotify(IntPtr callback);
      [PreserveSig] int UnregisterControlChangeNotify(IntPtr callback);
      [PreserveSig] int GetChannelCount(out uint count);
      [PreserveSig] int SetMasterVolumeLevel(float decibels, IntPtr eventContext);
      [PreserveSig] int SetMasterVolumeLevelScalar(float level, IntPtr eventContext);
      [PreserveSig] int GetMasterVolumeLevel(out float decibels);
      [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
      [PreserveSig] int SetChannelVolumeLevel(uint channel, float decibels, IntPtr eventContext);
      [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, IntPtr eventContext);
      [PreserveSig] int GetChannelVolumeLevel(uint channel, out float decibels);
      [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
      [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr eventContext);
      [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
      [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
      [PreserveSig] int VolumeStepUp(IntPtr eventContext);
      [PreserveSig] int VolumeStepDown(IntPtr eventContext);
      [PreserveSig] int QueryHardwareSupport(out uint supportMask);
      [PreserveSig] int GetVolumeRange(out float minimum, out float maximum, out float increment);
    }

    private static void Check(int result, string operation) {
      // S_FALSE (1), including an already-muted/unmuted endpoint, is success.
      if (result < 0) {
        throw new COMException(operation + " failed (HRESULT 0x" + result.ToString("X8") + ").", result);
      }
    }

    private static void Release(object instance) {
      if (instance != null && Marshal.IsComObject(instance)) Marshal.FinalReleaseComObject(instance);
    }

    public static void Apply() {
      object enumeratorObject = null;
      IMMDevice device = null;
      object volumeObject = null;
      try {
        enumeratorObject = new MMDeviceEnumeratorComObject();
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)enumeratorObject;
        // EDataFlow.eRender = 0; ERole.eMultimedia = 1.
        Check(enumerator.GetDefaultAudioEndpoint(0, 1, out device), "Finding the default audio output");
        Guid volumeId = typeof(IAudioEndpointVolume).GUID;
        // CLSCTX_ALL = INPROC_SERVER | INPROC_HANDLER | LOCAL_SERVER | REMOTE_SERVER.
        // Activation parameters and event-context GUID pointers may be NULL.
        Check(device.Activate(ref volumeId, 23, IntPtr.Zero, out volumeObject), "Opening the audio volume control");
        IAudioEndpointVolume endpoint = (IAudioEndpointVolume)volumeObject;
        /* APPLY_COMMANDS */
      } finally {
        // Each object belongs exclusively to this short-lived action process.
        // Nested finally blocks still release the remaining refs if cleanup fails.
        try { Release(volumeObject); }
        finally {
          try { Release(device); }
          finally { Release(enumeratorObject); }
        }
      }
    }
  }
}
`;

export function buildVolumeScript({ percent, mute }: { percent?: number; mute?: boolean }): string {
  const operations: string[] = [];
  if (percent !== undefined) {
    if (!Number.isFinite(percent)) throw new Error("Volume percentage must be a finite number.");
    // Core Audio accepts a 32-bit float in [0, 1]. JS toString uses invariant
    // decimal/scientific syntax, so generated C# never depends on OS culture.
    const scalar = Math.fround(Math.max(0, Math.min(100, percent)) / 100);
    operations.push('Check(endpoint.SetMasterVolumeLevelScalar(' + scalar.toString() + 'f, IntPtr.Zero), "Setting the audio volume");');
  }
  if (mute !== undefined) {
    if (typeof mute !== "boolean") throw new Error("Mute state must be true or false.");
    operations.push('Check(endpoint.SetMute(' + (mute ? "true" : "false") + ', IntPtr.Zero), "Setting audio mute");');
  }
  if (!operations.length) throw new Error("No audio volume change was requested.");
  return "$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n" +
    CORE_AUDIO_CS.replace("/* APPLY_COMMANDS */", operations.join("\n        ")) +
    "\n'@\n[Dragon.AudioEndpoint]::Apply()";
}
