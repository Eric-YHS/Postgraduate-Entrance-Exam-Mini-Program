param(
    [int]$ListenPort = 14173,
    [Parameter(Mandatory = $true)]
    [string]$TargetHost,
    [int]$TargetPort = 4173
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.Sockets;
using System.Threading;

namespace YanbanLocalProxy {
    public static class Server {
        public static void Run(int listenPort, string targetHost, int targetPort) {
            var listener = new TcpListener(IPAddress.Loopback, listenPort);
            listener.Start();
            while (true) {
                var client = listener.AcceptTcpClient();
                var state = new object[] { client, targetHost, targetPort };
                var thread = new Thread(Handle);
                thread.IsBackground = true;
                thread.Start(state);
            }
        }

        private static void Handle(object value) {
            var state = (object[])value;
            var client = (TcpClient)state[0];
            var targetHost = (string)state[1];
            var targetPort = (int)state[2];
            TcpClient target = null;
            try {
                target = new TcpClient();
                target.Connect(targetHost, targetPort);
                var clientStream = client.GetStream();
                var targetStream = target.GetStream();
                var a = new Thread(() => Copy(clientStream, targetStream));
                var b = new Thread(() => Copy(targetStream, clientStream));
                a.IsBackground = true;
                b.IsBackground = true;
                a.Start();
                b.Start();
                a.Join();
                b.Join();
            } catch {
            } finally {
                if (target != null) target.Close();
                client.Close();
            }
        }

        private static void Copy(NetworkStream source, NetworkStream destination) {
            try { source.CopyTo(destination); } catch { }
            try { destination.Close(); } catch { }
        }
    }
}
'@

[YanbanLocalProxy.Server]::Run($ListenPort, $TargetHost, $TargetPort)
