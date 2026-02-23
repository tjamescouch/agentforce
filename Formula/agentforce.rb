class Agentforce < Formula
  desc "Enterprise dashboard for AgentChat - chat, channels, agents, file transfer, network graph"
  homepage "https://github.com/tjamescouch/agentforce"
  url "https://github.com/tjamescouch/agentforce/archive/refs/tags/v1.1.2.tar.gz"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", "--production"
    system "npm", "run", "build"

    libexec.install Dir["*"]

    (bin/"agentforce").write <<~EOS
      #!/bin/bash
      cd "#{libexec}" && exec node server/dist/index.js "$@"
    EOS
  end

  def post_install
    (var/"agentforce").mkpath
  end

  service do
    run [opt_bin/"agentforce"]
    keep_alive true
    working_dir var/"agentforce"
    log_path var/"log/agentforce.log"
    error_log_path var/"log/agentforce.error.log"
    environment_variables(
      AGENTCHAT_PUBLIC: "false",
      PORT: "3000"
    )
  end

  test do
    # Check the server starts and responds
    port = free_port
    pid = fork do
      ENV["PORT"] = port.to_s
      ENV["AGENTCHAT_PUBLIC"] = "false"
      exec bin/"agentforce"
    end
    sleep 3
    begin
      assert_match "agentforce", shell_output("curl -s http://localhost:#{port}/")
    ensure
      Process.kill("TERM", pid)
    end
  end
end
