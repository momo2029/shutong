#!/bin/bash
# 在emqx容器内创建MQTT用户
# 用法: bash add_emqx_users.sh <server_pass> <device_pass>

PASS1="$1"
PASS2="$2"

# 在容器内写入erlang脚本
docker exec docker-emqx-1 sh -c "cat > /tmp/add_users.erl << 'ERLEOF'
#!/usr/bin/env escript
%%! -noshell -smp
main([Pass1, Pass2]) ->
    {ok, _} = application:ensure_all_started(emqx),
    ok = emqx_authn_mnesia:put_user(#{
        username = <<\"sht_server\">>,
        password = list_to_binary(Pass1)
    }),
    ok = emqx_authn_mnesia:put_user(#{
        username = <<\"sht_device\">>,
        password = list_to_binary(Pass2)
    }),
    io:format(\"Users created successfully~n\"),
    init:stop();
main(_) ->
    io:format(\"Error: expected 2 args~n\"),
    halt(1).
ERLEOF"

EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
    echo "Failed to create erlang script in container"
    exit 1
fi

# 执行erlang脚本
docker exec docker-emqx-1 /opt/emqx/erts-13.2.2/bin/escript /tmp/add_users.erl "$PASS1" "$PASS2"
