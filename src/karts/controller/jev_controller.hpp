//  SuperTuxKart - a fun racing game with go-kart
//  Copyright (C) 2026 SuperTuxKart-Jev contributors
//
//  This program is free software; you can redistribute it and/or
//  modify it under the terms of the GNU General Public License
//  as published by the Free Software Foundation; either version 3
//  of the License, or (at your option) any later version.

#ifndef HEADER_JEV_CONTROLLER_HPP
#define HEADER_JEV_CONTROLLER_HPP

#include "karts/controller/local_player_controller.hpp"

#include <enet/enet.h>

#include <cstdint>
#include <string>
#include <vector>

/** A local player controller driven by JSON datagrams on localhost.
 *
 *  SuperTuxKart sends structured race telemetry to a local bridge. The
 *  bridge evaluates it with Jev and sends a flat JSON control object back.
 *  The socket is deliberately bound to loopback so enabling this controller
 *  does not expose a remote-control port on the network.
 */
class JevController : public LocalPlayerController
{
private:
    struct Command
    {
        uint64_t sequence;
        float steer;
        float accel;
        bool brake;
        bool nitro;
        bool drift;
        bool rescue;
        bool fire;

        Command()
            : sequence(0), steer(0.0f), accel(0.0f), brake(true),
              nitro(false), drift(false), rescue(false), fire(false)
        {
        }
    };

    static bool s_enabled;
    static int s_state_port;
    static int s_control_port;
    static int s_telemetry_hz;
    static int s_timeout_ms;
    static bool s_waiting_for_start;
    static uint64_t s_next_session_id;

    ENetSocket  m_socket;
    ENetAddress m_state_address;
    bool        m_enet_initialized;
    bool        m_socket_ready;

    Command  m_command;
    bool     m_has_command;
    uint64_t m_last_command_ms;
    int      m_ticks_until_telemetry;
    int      m_track_node;
    uint64_t m_session_id;
    uint64_t m_state_sequence;
    bool     m_has_dashboard;
    std::vector<std::string> m_dashboard_lines;
    bool     m_has_input_history;
    std::vector<std::string> m_input_history_lines;

    void pollCommands();
    void applyCommand();
    void sendTelemetry();
    std::string makeTelemetry();

public:
    static bool configure(int state_port, int control_port,
                          int telemetry_hz, int timeout_ms);
    static bool isEnabled() { return s_enabled; }
    static bool isWaitingForStart()
                         { return s_enabled && s_waiting_for_start; }
    static void startDriving() { s_waiting_for_start = false; }

    JevController(AbstractKart *kart, int local_player_id, HandicapLevel h);
    virtual ~JevController();

    virtual void update(int ticks) OVERRIDE;
    virtual void reset() OVERRIDE;
    virtual bool action(PlayerAction action, int value,
                        bool dry_run=false) OVERRIDE;
    virtual bool canGetAchievements() const OVERRIDE { return false; }

    bool hasDashboard() const { return m_has_dashboard; }
    const std::vector<std::string>& getDashboardLines() const
                                      { return m_dashboard_lines; }
    bool hasInputHistory() const { return m_has_input_history; }
    const std::vector<std::string>& getInputHistoryLines() const
                                      { return m_input_history_lines; }
};

#endif // HEADER_JEV_CONTROLLER_HPP
