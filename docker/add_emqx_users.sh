#!/bin/bash
# 在emqx容器内创建MQTT用户
# 用法: bash add_emqx_users.sh <server_pass> <device_pass>

PASS1="$1"
PASS2="$2"

if [ -z "$PASS1" ] || [ -z "$PASS2" ]; then
    echo "用法: bash add_emqx_users.sh <server_pass> <device_pass>"
    exit 1
fi

# 用 base64 编码密码避免 shell 转义问题
B64_PASS1=$(echo -n "$PASS1" | base64)
B64_PASS2=$(echo -n "$PASS2" | base64)

# 在容器内写入 erlang 脚本
docker exec docker-emqx-1 sh -c "cat > /tmp/add_users.erl << 'ERLEOF'
#!/usr/bin/env escript
%%! -noshell
main(_) ->
    application:ensure_all_started(emqx),
    P1 = base64:decode(\"$B64_PASS1\"),
    P2 = base64:decode(\"$B64_PASS2\"),
    R1 = emqx_authn_mnesia:put_user(#{username => <<\"sht_server\">>, password => P1}),
    io:format(\"User sht_server: ~p~n\", [R1]),
    R2 = emqx_authn_mnesia:put_user(#{username => <<\"st_device\">>, password => P2}),
    io:format(\"User st_device: ~p~n\", [R2]),
    init:stop().
ERLEOF"

if [ $? -ne 0 ]; then
    echo "Failed to create erlang script in container"
    exit 1
fi

# 执行 erlang 脚本
docker exec docker-emqx-1 /opt/emqx/erts-13.2.2/bin/escript /tmp/add_users.erl
