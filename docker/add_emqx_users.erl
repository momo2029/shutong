#!/usr/bin/env escript
%%! -noshell
main([Pass1, Pass2]) ->
    User1 = #{
        username => <<"sht_server">>,
        password => list_to_binary(Pass1)
    },
    User2 = #{
        username => <<"sht_device">>,
        password => list_to_binary(Pass2)
    },
    case emqx_authn_mnesia:put_user(User1) of
        ok -> io:format("User sht_server created~n");
        {error, Reason1} -> io:format("User sht_server error: ~p~n", [Reason1])
    end,
    case emqx_authn_mnesia:put_user(User2) of
        ok -> io:format("User sht_device created~n");
        {error, Reason2} -> io:format("User sht_device error: ~p~n", [Reason2])
    end,
    init:stop();
main(_) ->
    io:format("Error: expected 2 args~n"),
    halt(1).
