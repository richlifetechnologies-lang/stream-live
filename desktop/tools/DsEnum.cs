using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

// Minimal DirectShow device enumerator: lists what ICreateDevEnum reports for a
// device category. This is the same enumeration path OBS / Zoom / Skype use for
// DirectShow capture devices, so it tells us the ground truth of what the OS
// exposes (independent of any app's own caching or Media Foundation path).
static class DsEnum
{
    [ComImport, Guid("62BE5D10-60EB-11d0-BD3B-00A0C911CE86"), ClassInterface(ClassInterfaceType.None)]
    class SystemDeviceEnum { }

    [ComImport, Guid("62BE5D10-60EB-11d0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ICreateDevEnum
    {
        int CreateClassEnumerator([In] ref Guid clsidDeviceClass, [Out] out IEnumMoniker ppEnumMoniker, [In] int dwFlags);
    }

    [ComImport, Guid("55272A00-42CB-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyBag
    {
        int Read([In, MarshalAs(UnmanagedType.LPWStr)] string pszPropName, [Out] out object pVar, [In] IntPtr pErrorLog);
        int Write([In, MarshalAs(UnmanagedType.LPWStr)] string pszPropName, [In] ref object pVar);
    }

    static readonly Guid CLSID_VideoInputDeviceCategory = new Guid("860BB310-5D01-11d0-BD3B-00A0C911CE86");
    static readonly Guid CLSID_AudioInputDeviceCategory = new Guid("33D9A762-90C8-11d0-BD43-00A0C911CE86");

    static void List(string title, Guid cat)
    {
        Console.WriteLine("=== " + title + " ===");
        var de = (ICreateDevEnum)new SystemDeviceEnum();
        IEnumMoniker em;
        int hr = de.CreateClassEnumerator(ref cat, out em, 0);
        if (hr != 0 || em == null) { Console.WriteLine("  (no enumerator / empty)"); return; }
        IMoniker[] mon = new IMoniker[1];
        int fetched;
        while (em.Next(1, mon, new IntPtr(0)) == 0 && mon[0] != null)
        {
            object bagObj;
            Guid iidIPropertyBag = typeof(IPropertyBag).GUID;
            mon[0].BindToStorage(null, null, ref iidIPropertyBag, out bagObj);
            if (bagObj != null)
            {
                var bag = (IPropertyBag)bagObj;
                object fn, cls;
                string name = "?", clsid = "?";
                if (bag.Read("FriendlyName", out fn, IntPtr.Zero) == 0 && fn != null) name = fn.ToString();
                if (bag.Read("CLSID", out cls, IntPtr.Zero) == 0 && cls != null) clsid = cls.ToString();
                Console.WriteLine("  " + name + "   [" + clsid + "]");
            }
            Marshal.ReleaseComObject(mon[0]);
            fetched = 1;
        }
        Marshal.ReleaseComObject(em);
    }

    static void Main()
    {
        List("DirectShow VIDEO INPUT devices", CLSID_VideoInputDeviceCategory);
        List("DirectShow AUDIO INPUT devices", CLSID_AudioInputDeviceCategory);
    }
}
